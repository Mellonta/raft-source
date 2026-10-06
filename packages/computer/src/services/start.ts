// StartService — Computer domain service for `raft-computer start`
// (RFC v0.8 contract v4 §6 line 80). CLI and Electron main are both
// adapters over this surface; the service itself never touches
// process.stdout / process.stderr / process.exit.
//
// Shape (Hao msg=51a17400 + liuliu msg=7a1a2c3d / 35034229 / bb503633):
//   - typed StartInput + StartOptions (onEvent best-effort + AbortSignal)
//   - typed StartResult on success — carries `status` ("running" |
//     "already_running" | "spawned" | "foreground" | "aborted") so
//     post-spawn AbortSignal can return without throwing.
//   - typed `ComputerServiceError { code, message, cause? }` thrown on
//     failure; cause retained in-process only — adapters MUST NOT forward it.
//   - §6 closed-set codes preserved BYTE-IDENTICAL: NO_ATTACHMENT /
//     NOT_ATTACHED / SUPERVISOR_SPAWN_FAILED / START_DAEMON_TIMEOUT.
//   - AbortSignal honored before EACH network/process boundary AND before
//     spawn. POST-SPAWN abort = no-op (returns StartResult with
//     status="aborted"). NEVER SIGKILL detached service (Hao
//     msg=7a1a2c3d product invariant: terminal close ≠ service kill,
//     UI close ≠ service kill — service lifecycle is detached
//     from any single client surface).
//   - `runService` foreground path stays as-is (long-running blocking
//     call); service emits `running` event then awaits the service loop.
//   - `formatReadySummary` stays in the ADAPTER (per liuliu msg=bb503633
//     narrow-split): the service emits a structured `ready` event with the
//     ready Map + managed targets; the adapter formats the user-visible
//     line. Keeps service env-pure.
import { setTimeout as delay } from "node:timers/promises";

import { currentTimeMs } from "@botiverse/raft-shared";
import { isProcessAlive, readPidfileAt } from "../internal/process-primitives";
import { findLiveServicePid } from "../internal/service-pid-fallback";
import {
  PARENT_LOCK_HELD_ENV_VAR,
  readServiceVersionEvidence,
  runService,
  spawnDetachedService,
} from "../service";
import { connectService } from "../lib/ipc-client";
import {
  serverRunnerLogReadFallback,
  serviceLogPath,
  serviceVersionPath,
} from "../paths";
import { listAttachedServerIds, readServerAttachment, setServerManaged } from "../serverState";
import { isDegraded, readTerminalUnlinked } from "../health";
import { resetRunner } from "../reset";
import type { ComputerApiEvent } from "../lib/events";
import { ComputerServiceError } from "./errors";
import { COMPUTER_VERSION } from "../version";
import { hasUnlinkedComputerHandshake, readRunnerLogTail } from "../internal/runner-log-diagnostics";
import { collectMachineFacts } from "../machineFacts";
import { machineReadiness } from "../machineReadiness";
import {
  convergeCliHostLifecycle,
  hostLifecycleSkipped,
  type MacosHostLifecycleDeps,
} from "../macosLoginCarrier";

const START_ENSURE_TIMEOUT_MS = 15_000;
const START_ENSURE_POLL_INTERVAL_MS = 100;
const SERVICE_IDENTITY_SETTLE_ATTEMPTS = 20;
const SERVICE_IDENTITY_SETTLE_POLL_MS = 100;
const inFlightStartByHome = new Map<string, Promise<StartResult>>();

export interface StartInput {
  /** Optional: start one attached server without changing other managed
   *  servers. When omitted, all attached servers are marked managed. */
  serverId?: string | null;
  /** Optional: original user-typed slug ("/alpha") used for
   *  user-visible labels and error messages. Service uses this only to
   *  echo back into structured events; the adapter renders it. */
  serverLabel?: string | null;
  /** When true, runService() runs inline in the calling process.
   *  When false (default), the service is spawned detached. */
  foreground?: boolean;
  /** The Computer install root to manage. Required: env resolution lives at
   *  `createComputerApi` construction so mutations can't silently regress to
   *  ambient `~/.slock`. (#wg-raft-computer:f2a02081 BUG 3 sweep.) */
  slockHome: string;
  /** Which durable host-lifecycle owner this caller represents. Internal
   *  callers/tests may use `none`; CLI and Electron adapters must be explicit. */
  hostLifecycleOwner?: "cli" | "app" | "none";
}

export type StartStatus =
  | "running"          // foreground service loop returned (ran to completion / was Ctrl-C'd)
  | "already_running"  // existing service pidfile alive; daemons reconciled
  | "spawned"          // detached service spawned + all managed daemons ready
  | "aborted";         // post-spawn AbortSignal: spawn already committed, service still running

export interface StartResult {
  status: StartStatus;
  /** Managed set for this start invocation (single id when serverId
   *  was set; full attached set otherwise). */
  managedTargets: string[];
  /** Total number of attached servers at the moment of start (includes
   *  managedTargets when start was global). */
  attachedCount: number;
  /** Map of serverId → daemon pid for daemons confirmed ready before
   *  return. Empty when status === "running" (foreground); on
   *  status === "aborted" reflects whatever was ready at the moment
   *  the abort was observed. */
  ready: Map<string, number>;
  /** Pid of the (newly spawned OR existing) service when known.
   *  null for status === "running" (the calling process IS the
   *  service in foreground mode). */
  servicePid: number | null;
  /** Path of the service's combined log (for adapter "Logs: …" line). */
  serviceLogPath: string;
}

export interface StartDeps {
  /** Test seams (default to module-level real impls). Mirrors the
   *  pre-extraction `RunStartDeps` shape so existing service.test.ts
   *  test cases keep working through the adapter. */
  spawnDetachedService?: typeof spawnDetachedService;
  readPidfile?: typeof readPidfileAt;
  isProcessAlive?: typeof isProcessAlive;
  sleep?: (ms: number) => Promise<void>;
  ensureTimeoutMs?: number;
  ensurePollIntervalMs?: number;
  /** Foreground service loop. Default: real `runService`. */
  runService?: typeof runService;
  /** Test seam for explicit start/restart retry recovery. */
  resetRunnerRecoveryState?: typeof resetRunnerRecoveryStateViaServiceOrDisk;
  /** Abort the pre-spawn/wait path if the caller loses its mutation lock. */
  signal?: AbortSignal;
  convergeHostLifecycle?: typeof convergeCliHostLifecycle;
  hostLifecycleDeps?: MacosHostLifecycleDeps;
}

export interface StartOptions extends StartDeps {
  onEvent?: (event: ComputerApiEvent) => void;
}

function emit(opts: StartOptions | undefined, event: ComputerApiEvent): void {
  const cb = opts?.onEvent;
  if (!cb) return;
  try {
    cb(event);
  } catch {
    // onEvent is best-effort — never let a renderer/listener fault
    // break the start flow.
  }
}

async function readStartReadiness(
  slockHome: string,
  serverIds: string[],
  opts: StartOptions,
) {
  const facts = await collectMachineFacts(slockHome, {
    runnerServerIds: serverIds,
    readPidfile: opts.readPidfile ?? readPidfileAt,
    isAlive: opts.isProcessAlive ?? isProcessAlive,
  });
  return machineReadiness(facts, {
    targetServerIds: serverIds,
    expectedVersion: COMPUTER_VERSION,
  });
}

async function waitForManagedDaemonPids(
  slockHome: string,
  serverIds: string[],
  opts: StartOptions,
  observeAbort = true,
): Promise<Map<string, number>> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = opts.ensureTimeoutMs ?? START_ENSURE_TIMEOUT_MS;
  const pollIntervalMs = opts.ensurePollIntervalMs ?? START_ENSURE_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let ready = new Map<string, number>();
  const throwIfAborted = (): void => {
    if (observeAbort) opts.signal?.throwIfAborted?.();
  };

  for (;;) {
    throwIfAborted();
    const verdict = await readStartReadiness(slockHome, serverIds, opts);
    ready = new Map(verdict.runnerPids);
    if (verdict.ready) {
      throwIfAborted();
      return ready;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return ready;
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}

/** A starting service publishes its pidfile before its version evidence
 * (`publishServiceIdentityAfterIpcBind`), so a `start` that polls the pidfile
 * can see the new pid beside the previous service's evidence, or beside none.
 * That is publication in progress, not skew: re-read a bounded number of times
 * before judging. A matching pid with a different version is never retried. */
async function readSettledServiceVersionEvidence(
  slockHome: string,
  servicePid: number,
  opts: StartOptions,
) {
  const sleep = opts.sleep ?? ((ms: number) => delay(ms));
  let evidence = await readServiceVersionEvidence(slockHome);
  for (
    let attempt = 0;
    attempt < SERVICE_IDENTITY_SETTLE_ATTEMPTS
      && (evidence === null || evidence.pid !== servicePid);
    attempt += 1
  ) {
    opts.signal?.throwIfAborted?.();
    await sleep(SERVICE_IDENTITY_SETTLE_POLL_MS);
    evidence = await readServiceVersionEvidence(slockHome);
  }
  return evidence;
}

async function assertNoServiceVersionSkew(
  slockHome: string,
  servicePid: number,
  opts: StartOptions,
): Promise<void> {
  const evidence = await readSettledServiceVersionEvidence(slockHome, servicePid, opts);
  if (!evidence) {
    throw new ComputerServiceError(
      "SERVICE_VERSION_SKEW_SUSPECT",
      `A Raft Computer service is already running (pid ${servicePid}), but this app/CLI could not verify its version from ${serviceVersionPath(slockHome)}. Restart the Computer service from the current app/CLI, then try again. Run \`raft-computer restart\` or quit and reopen Raft Desktop.`,
    );
  }
  if (evidence.pid !== servicePid) {
    throw new ComputerServiceError(
      "SERVICE_VERSION_SKEW_SUSPECT",
      `A Raft Computer service is already running (pid ${servicePid}), but this app/CLI found version evidence for a different process (pid ${evidence.pid}) at ${serviceVersionPath(slockHome)}. Restart the Computer service from the current app/CLI, then try again. Run \`raft-computer restart\` or quit and reopen Raft Desktop.`,
    );
  }
  if (evidence.version === null || evidence.version === COMPUTER_VERSION) return;

  throw new ComputerServiceError(
    "SERVICE_VERSION_SKEW",
    `A Raft Computer service from version ${evidence.version} is already running (pid ${servicePid}), but this app/CLI is version ${COMPUTER_VERSION}. Restart the Computer service from the current app/CLI, then try again. Run \`raft-computer restart\` or quit and reopen Raft Desktop.`,
  );
}

async function resetRunnerRecoveryStateViaServiceOrDisk(
  slockHome: string,
  serverId: string,
  existingServicePid: number | null,
): Promise<void> {
  if (existingServicePid === null) {
    await resetRunner(slockHome, serverId);
    return;
  }

  let client: Awaited<ReturnType<typeof connectService>> | null = null;
  try {
    client = await connectService(slockHome);
    await client.request("reset-runner", { serverId });
  } finally {
    await client?.close();
  }
}

async function clearDegradedRecoveryStateForStart(
  slockHome: string,
  serverIds: string[],
  existingServicePid: number | null,
  opts: StartOptions,
): Promise<void> {
  const reset = opts.resetRunnerRecoveryState ?? resetRunnerRecoveryStateViaServiceOrDisk;
  const nowMs = Date.now();
  for (const serverId of serverIds) {
    opts.signal?.throwIfAborted?.();
    if (await isDegraded(slockHome, serverId, nowMs)) {
      opts.signal?.throwIfAborted?.();
      await reset(slockHome, serverId, existingServicePid);
    }
  }
}

function buildTerminalUnlinkedMessage(slockHome: string, serverId: string, label: string): string {
  return (
    `Cannot start ${label}: the server rejected the saved Computer runner state as computer_machine_unlinked. ` +
    `The server has unlinked or deleted this Computer/machine, so retrying would keep failing. ` +
    `Run \`raft-computer setup ${label}\` to recover/rebind this Computer, then verify with \`raft-computer status ${label}\`. ` +
    `Diagnostics are available in ${serverRunnerLogReadFallback(slockHome, serverId)[0]} if support asks for them.`
  );
}

/**
 * Drop attachments the server has terminally unlinked from an unscoped start.
 * One unlinked server must not keep the rest offline: the upgrade engine
 * restarts the service with an unscoped `start`, so refusing here fails both
 * the candidate start and the rollback. A scoped start of an unlinked server,
 * or an unscoped start where every target is unlinked, still refuses.
 */
async function selectStartableTargets(
  slockHome: string,
  serverIds: string[],
  input: StartInput,
): Promise<{ startable: string[]; unlinked: string[] }> {
  const startable: string[] = [];
  const unlinked: string[] = [];
  for (const serverId of serverIds) {
    const attachment = await readServerAttachment(slockHome, serverId);
    if (await readTerminalUnlinked(slockHome, serverId, attachment?.serverMachineId ?? null)) {
      unlinked.push(serverId);
    } else {
      startable.push(serverId);
    }
  }
  if (unlinked.length > 0 && (input.serverId || startable.length === 0)) {
    const serverId = unlinked[0]!;
    const label = input.serverId === serverId ? input.serverLabel ?? serverId : serverId;
    throw new ComputerServiceError(
      "COMPUTER_MACHINE_UNLINKED",
      buildTerminalUnlinkedMessage(slockHome, serverId, label),
    );
  }
  return { startable, unlinked };
}

async function buildTimeoutMessage(
  slockHome: string,
  serverIds: string[],
  ready: Map<string, number>,
  input: StartInput,
): Promise<string> {
  const missing = serverIds.filter((id) => !ready.has(id));
  for (const serverId of missing) {
    const logTail = await readRunnerLogTail(serverRunnerLogReadFallback(slockHome, serverId));
    if (!hasUnlinkedComputerHandshake(logTail)) continue;

    const label = input.serverId === serverId ? input.serverLabel ?? serverId : serverId;
    return (
      `Timed out waiting for ${label} to start because the server rejected this Computer as ` +
      `computer_machine_unlinked. The server has unlinked or deleted this Computer/machine; ` +
      `run \`raft-computer setup ${label}\` to reconnect, then verify with \`raft-computer status ${label}\`. Inspect ${serviceLogPath(slockHome)} and ` +
      `${serverRunnerLogReadFallback(slockHome, serverId)[0]} for details.`
    );
  }

  const target =
    input.serverId && missing.length === 1
      ? `${input.serverLabel ?? input.serverId}`
      : `${missing.length} server runner(s): ${missing.join(", ")}`;
  const runnerLogPaths = missing.map(
    (serverId) => serverRunnerLogReadFallback(slockHome, serverId)[0],
  );
  return (
    `Timed out waiting for ${target} to start. Run \`raft-computer status\` and inspect ` +
    `${serviceLogPath(slockHome)} plus per-server runner logs: ${runnerLogPaths.join(", ")}.`
  );
}

export async function start(input: StartInput, options: StartOptions = {}): Promise<StartResult> {
  const prior = inFlightStartByHome.get(input.slockHome);
  if (prior) {
    try {
      await prior;
    } catch {
      // The waiting caller re-runs the start path below and reports its own
      // result/error against the current filesystem state.
    }
  }

  const current = startInner(input, options);
  inFlightStartByHome.set(input.slockHome, current);
  try {
    return await current;
  } finally {
    if (inFlightStartByHome.get(input.slockHome) === current) {
      inFlightStartByHome.delete(input.slockHome);
    }
  }
}

async function startInner(input: StartInput, options: StartOptions = {}): Promise<StartResult> {
  options.signal?.throwIfAborted?.();
  const { slockHome } = input;

  // 1. Validate attached set — service-axis throw, byte-identical message.
  const attached = await listAttachedServerIds(slockHome);
  options.signal?.throwIfAborted?.();
  if (attached.length === 0) {
    throw new ComputerServiceError(
      "NO_ATTACHMENT",
      "No server attachments yet. Run `raft-computer attach /<serverSlug>` first.",
    );
  }
  if (input.serverId && !attached.includes(input.serverId)) {
    throw new ComputerServiceError(
      "NOT_ATTACHED",
      `Not attached to server ${input.serverId}. Run \`raft-computer attach ${input.serverId}\` first or omit the argument.`,
    );
  }

  // 2. Decide start targets + write managed.flag for each target.
  // Contract v4 §6 line 80: pre-spawn write so the service's first
  // reconcile picks up the correct managed intent. Scoped start is additive:
  // it must not clear another server that the user already brought online.
  // Use `stop <server>` to clear that server's managed intent explicitly.
  const requestedTargets = input.serverId ? [input.serverId] : attached;
  emit(options, {
    kind: "start.starting",
    managedTargets: requestedTargets,
    attachedCount: attached.length,
    foreground: !!input.foreground,
  });

  const { startable: managedTargets, unlinked } = await selectStartableTargets(
    slockHome,
    requestedTargets,
    input,
  );
  if (unlinked.length > 0) {
    emit(options, { kind: "start.skipped_unlinked", serverIds: unlinked });
  }
  options.signal?.throwIfAborted?.();

  for (const id of managedTargets) {
    options.signal?.throwIfAborted?.();
    await setServerManaged(slockHome, id);
  }

  // The CLI no longer autostarts at login: this only removes a leftover macOS
  // LaunchAgent from older releases and records the owner. It never starts
  // the service (step 3 below does) and a failure never blocks the start.
  if ((input.hostLifecycleOwner ?? "none") !== "none") {
    try {
      await (options.convergeHostLifecycle ?? convergeCliHostLifecycle)(
        slockHome,
        "enabled",
        options.hostLifecycleDeps ?? {},
      );
    } catch (error) {
      emit(options, hostLifecycleSkipped("start", error));
    }
    options.signal?.throwIfAborted?.();
  }

  // 3. Idempotent live-service pidfile check. Walk the on-disk
  //    layout migration window (current `run/service.pid` → legacy
  //    `service.pid` → legacy `supervisor.pid`) by liveness. Picking by
  //    readability alone would let a stale current pidfile shadow a
  //    still-live legacy service: a new CLI would see "no service" and
  //    spawn a second one alongside the legacy. Service is one-per-
  //    Computer (RFC v9.8 §1) — the symmetry has to hold across stop /
  //    upgrade / start / status. The helper clears stale candidates in
  //    place so they do not haunt later reads.
  const { pid: existing } = await findLiveServicePid(slockHome, {
    readPidfile: options.readPidfile,
    isProcessAlive: options.isProcessAlive,
  });
  options.signal?.throwIfAborted?.();
  await clearDegradedRecoveryStateForStart(slockHome, managedTargets, existing, options);
  options.signal?.throwIfAborted?.();
  if (existing !== null) {
    await assertNoServiceVersionSkew(slockHome, existing, options);
    options.signal?.throwIfAborted?.();
    emit(options, {
      kind: "start.already_running",
      servicePid: existing,
      managedTargets,
      attachedCount: attached.length,
    });
    const ready = await waitForManagedDaemonPids(slockHome, managedTargets, options);
    if (ready.size !== managedTargets.length) {
      const message = await buildTimeoutMessage(slockHome, managedTargets, ready, input);
      options.signal?.throwIfAborted?.();
      throw new ComputerServiceError(
        "START_DAEMON_TIMEOUT",
        message,
      );
    }
    emit(options, { kind: "start.ready", ready, managedTargets });
    return {
      status: "already_running",
      managedTargets,
      attachedCount: attached.length,
      ready,
      servicePid: existing,
      serviceLogPath: serviceLogPath(slockHome),
    };
  }

  // 4. Foreground path: run the service loop inline. Service emits
  // `running` event, then yields control to runService (which blocks
  // until SIGTERM / Ctrl-C). On return, we report status="running" with
  // an empty `ready` map (foreground service is its own observer).
  if (input.foreground) {
    options.signal?.throwIfAborted?.();
    emit(options, {
      kind: "start.running",
      managedTargets,
      attachedCount: attached.length,
    });
    const service = options.runService ?? runService;
    const previousParentLockMarker = process.env[PARENT_LOCK_HELD_ENV_VAR];
    process.env[PARENT_LOCK_HELD_ENV_VAR] = "1";
    try {
      await service();
    } finally {
      if (previousParentLockMarker === undefined) delete process.env[PARENT_LOCK_HELD_ENV_VAR];
      else process.env[PARENT_LOCK_HELD_ENV_VAR] = previousParentLockMarker;
    }
    return {
      status: "running",
      managedTargets,
      attachedCount: attached.length,
      ready: new Map(),
      servicePid: null,
      serviceLogPath: serviceLogPath(slockHome),
    };
  }

  // 5. Background path: Computer's detached service is the canonical owner
  // on every OS. Legacy launchd/systemd/Task Scheduler definitions are
  // deliberately ignored and left byte-for-byte untouched.
  // Pre-spawn AbortSignal check (last opportunity
  // before we commit to a detached process). After spawn, the service
  // is detached + has its own lifecycle — abort becomes a no-op.
  options.signal?.throwIfAborted?.();

  let pid: number;
  try {
    pid = await (options.spawnDetachedService ?? spawnDetachedService)(slockHome);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ComputerServiceError("SUPERVISOR_SPAWN_FAILED", msg, err);
  }

  emit(options, {
    kind: "start.spawned",
    servicePid: pid,
    managedTargets,
    attachedCount: attached.length,
  });

  // 6. Post-spawn abort check. Spawn already committed; the detached
  // service is the canonical owner from this point on. NEVER SIGKILL
  // — terminal close / UI close / Electron quit must all leave the
  // service running (Hao msg=7a1a2c3d product invariant).
  if (options.signal?.aborted) {
    const ready = await pollReadyOnce(slockHome, managedTargets, options);
    emit(options, { kind: "start.aborted", servicePid: pid, managedTargets, ready });
    return {
      status: "aborted",
      managedTargets,
      attachedCount: attached.length,
      ready,
      servicePid: pid,
      serviceLogPath: serviceLogPath(slockHome),
    };
  }

  // 7. Wait for all managed daemons to reach ready state.
  const ready = await waitForManagedDaemonPids(slockHome, managedTargets, options, false);
  if (ready.size !== managedTargets.length) {
    throw new ComputerServiceError(
      "START_DAEMON_TIMEOUT",
      await buildTimeoutMessage(slockHome, managedTargets, ready, input),
    );
  }

  emit(options, { kind: "start.ready", ready, managedTargets });
  return {
    status: "spawned",
    managedTargets,
    attachedCount: attached.length,
    ready,
    servicePid: pid,
    serviceLogPath: serviceLogPath(slockHome),
  };
}

/** One non-blocking sweep of the shared runner readiness facts. Used on post-spawn
 *  abort to capture whatever became ready before the abort fired,
 *  without paying the full poll-loop deadline. */
async function pollReadyOnce(
  slockHome: string,
  serverIds: string[],
  opts: StartOptions,
): Promise<Map<string, number>> {
  const verdict = await readStartReadiness(slockHome, serverIds, opts);
  return new Map(verdict.runnerPids);
}
