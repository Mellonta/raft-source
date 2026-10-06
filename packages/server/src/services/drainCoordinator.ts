/**
 * Drain coordinator: detects that ECS has started draining this task (the
 * target has been deregistered from the load balancer and the control plane
 * now wants the task STOPPED) and runs the going-away phase while
 * connections are still alive.
 *
 * Why this exists (task #261): the ALB severs connections to a draining
 * target the moment the deregistration delay expires, and ECS only sends
 * SIGTERM at roughly the same moment, so a SIGTERM-triggered going-away can
 * never beat the hard cut. The going-away phase has to be triggered by a
 * signal that arrives when draining *begins*, minutes before the cut.
 *
 * Which signal (task #268, measured on staging 2026-09-29): the task's own
 * metadata v4 endpoint only flips DesiredStatus to STOPPED when the task
 * leaves DEACTIVATING, i.e. at deregistration + delay, which is the moment
 * of the cut — every "Entering drain" fired at +306..317 s and closed 0
 * connections. The ECS control plane (DescribeTasks on this task) reports
 * desiredStatus=STOPPED from the start of draining. So the control plane is
 * the primary source and the metadata endpoint is kept as a second path.
 * Both feed one latch: whichever reports first fires the drain, exactly once.
 *
 * The going-away phase (closing daemon WebSockets with 1001, ending SSE
 * streams) must happen only once draining has actually started: a daemon
 * that reconnects within its 0–5s jitter must land on a healthy target, not
 * bounce back onto this one.
 */

export type DrainSignalSourceName = "control_plane" | "metadata";

export interface DrainSignalSource {
  readonly name: DrainSignalSourceName;
  /** Resolves true once the control plane wants this task stopped. Throws on
   * a transport or permission failure; the coordinator treats a throw as
   * "no signal this tick" and keeps polling. */
  probe(): Promise<boolean>;
}

/** Minimal fetch surface the metadata source needs; injectable for tests. */
export type DrainFetch = (
  url: string,
  init?: { signal: AbortSignal },
) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;

/** Minimal DescribeTasks surface the control-plane source needs. */
export type DescribeTaskDesiredStatus = (input: {
  cluster: string;
  taskArn: string;
  signal: AbortSignal;
}) => Promise<{ desiredStatus?: string | null; lastStatus?: string | null } | undefined>;

export interface DrainCoordinatorDeps {
  sources: readonly DrainSignalSource[];
  /** Called exactly once, with the source that reported the drain first. */
  onDrain: (source: DrainSignalSourceName) => void;
  /** Poll interval. Default 5_000 ms. */
  intervalMs?: number;
  warn?: (message: string, reason: unknown) => void;
  /** Called on every readiness transition of a source: the first successful
   * probe (ready=true) and the first failure (ready=false), plus each flip
   * afterwards. Startup diagnostics only; the drain verdict is `onDrain`'s
   * source argument. */
  onSourceReadiness?: (source: DrainSignalSourceName, ready: boolean, reason?: unknown) => void;
  /** Failure warnings per source are rate-limited: the first failure warns,
   * then one summary every this many consecutive failures. Default 60
   * (5 minutes at the default interval). */
  warnEvery?: number;
}

export interface DrainCoordinator {
  /** True once the drain signal has fired. */
  readonly draining: boolean;
  /** Source that fired the drain, once it has. */
  readonly drainSource: DrainSignalSourceName | null;
  /** Last known readiness per source (undefined until first probe). */
  readiness(source: DrainSignalSourceName): boolean | undefined;
  start(): void;
  stop(): void;
  /** Single poll of every source; exposed for tests. */
  pollOnce(): Promise<void>;
}

export const DEFAULT_DRAIN_POLL_INTERVAL_MS = 5_000;
/** Per-call timeout for the control-plane and metadata probes. One hung
 * request must never block the next tick; the drain window budget
 * (poll + timeout + spread + margin ≤ deregistration delay) is asserted in
 * machineDrain.test.ts and drain-window.tftest.hcl. */
export const DRAIN_PROBE_TIMEOUT_MS = 3_000;

export function createDrainCoordinator(deps: DrainCoordinatorDeps): DrainCoordinator {
  const intervalMs = deps.intervalMs ?? DEFAULT_DRAIN_POLL_INTERVAL_MS;
  const warnEvery = deps.warnEvery ?? 60;
  const warn = deps.warn ?? ((message: string, reason: unknown) => console.warn(`[Slock] ${message}:`, reason));

  let timer: ReturnType<typeof setInterval> | null = null;
  let fired = false;
  let firedBy: DrainSignalSourceName | null = null;
  let polling = false;
  const ready = new Map<DrainSignalSourceName, boolean>();
  const consecutiveFailures = new Map<DrainSignalSourceName, number>();

  const fire = (source: DrainSignalSourceName) => {
    // Single latch shared by every source: two sources reading STOPPED in
    // the same tick must still produce exactly one going-away phase.
    if (fired) return;
    fired = true;
    firedBy = source;
    coordinator.stop();
    // The drain callback owns its own failure: a throw here must not be
    // reported as a probe failure of `source` (the latch is already set, so
    // the drain would never retry, and the readiness line would lie).
    try {
      deps.onDrain(source);
    } catch (err) {
      warn(`Drain callback threw after ${source} reported the drain`, err);
    }
  };

  const noteResult = (source: DrainSignalSourceName, ok: boolean, reason?: unknown) => {
    const previous = ready.get(source);
    if (ok) {
      consecutiveFailures.set(source, 0);
      if (previous !== true) {
        ready.set(source, true);
        deps.onSourceReadiness?.(source, true);
      }
      return;
    }
    const failures = (consecutiveFailures.get(source) ?? 0) + 1;
    consecutiveFailures.set(source, failures);
    if (previous !== false) {
      ready.set(source, false);
      deps.onSourceReadiness?.(source, false, reason);
    }
    // Transient failures must not kill the poller: missing one tick only
    // delays the going-away phase by a few seconds. A steady failure (e.g.
    // a missing IAM permission) is reported once, then summarised.
    if (failures === 1) {
      warn(`Drain signal source ${source} failed`, reason);
    } else if (failures % warnEvery === 0) {
      warn(`Drain signal source ${source} still failing (${failures} consecutive)`, reason);
    }
  };

  const coordinator: DrainCoordinator = {
    get draining() {
      return fired;
    },
    get drainSource() {
      return firedBy;
    },
    readiness(source) {
      return ready.get(source);
    },
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void coordinator.pollOnce();
      }, intervalMs);
      // A stopped task must never be kept alive by this poll.
      (timer as { unref?: () => void }).unref?.();
      void coordinator.pollOnce();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    async pollOnce() {
      if (fired || polling) return;
      polling = true;
      try {
        await Promise.all(deps.sources.map(async (source) => {
          try {
            const stopping = await source.probe();
            noteResult(source.name, true);
            if (stopping) fire(source.name);
          } catch (err) {
            noteResult(source.name, false, err);
          }
        }));
      } finally {
        polling = false;
      }
    },
  };
  return coordinator;
}

/** Second path: the task's own metadata v4 endpoint. Flips late (at the
 * deregistration cut), so on its own it cannot beat the ALB; kept because it
 * needs no IAM and still covers the case where the control plane is
 * unreachable from the task. */
export function createMetadataDrainSource(deps: {
  /** Base URI from ECS_CONTAINER_METADATA_URI_V4 (…/task is appended). */
  metadataUri: string;
  fetchImpl?: DrainFetch;
  timeoutMs?: number;
}): DrainSignalSource {
  const fetchImpl = deps.fetchImpl ?? ((url: string, init?: { signal: AbortSignal }) => fetch(url, init));
  const timeoutMs = deps.timeoutMs ?? DRAIN_PROBE_TIMEOUT_MS;
  return {
    name: "metadata",
    async probe() {
      const response = await fetchImpl(`${deps.metadataUri}/task`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`ECS task metadata returned status=${response.status ?? "unknown"}`);
      const body = (await response.json()) as { DesiredStatus?: unknown };
      return body.DesiredStatus === "STOPPED";
    },
  };
}

/** Primary path: ECS DescribeTasks on this task. The control plane reports
 * desiredStatus=STOPPED (lastStatus DEACTIVATING) from the moment ECS begins
 * draining the task, which is deregistration time — minutes before the ALB
 * cut. Needs ecs:DescribeTasks on the task role (infra: modules/server-service). */
export function createControlPlaneDrainSource(deps: {
  cluster: string;
  taskArn: string;
  describeTask: DescribeTaskDesiredStatus;
  timeoutMs?: number;
}): DrainSignalSource {
  const timeoutMs = deps.timeoutMs ?? DRAIN_PROBE_TIMEOUT_MS;
  return {
    name: "control_plane",
    async probe() {
      const task = await deps.describeTask({
        cluster: deps.cluster,
        taskArn: deps.taskArn,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!task) throw new Error("DescribeTasks returned no task for this task ARN");
      return task.desiredStatus === "STOPPED";
    },
  };
}

/** Reads this task's identity from the metadata v4 endpoint once at startup
 * (the fields the control-plane source needs). Returns undefined when the
 * endpoint is unavailable or the body lacks them. */
export async function readEcsTaskIdentity(deps: {
  metadataUri: string;
  fetchImpl?: DrainFetch;
  timeoutMs?: number;
}): Promise<{ cluster: string; taskArn: string } | undefined> {
  const fetchImpl = deps.fetchImpl ?? ((url: string, init?: { signal: AbortSignal }) => fetch(url, init));
  const timeoutMs = deps.timeoutMs ?? DRAIN_PROBE_TIMEOUT_MS;
  const response = await fetchImpl(`${deps.metadataUri}/task`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) return undefined;
  const body = (await response.json()) as { Cluster?: unknown; TaskARN?: unknown };
  if (typeof body.Cluster !== "string" || typeof body.TaskARN !== "string") return undefined;
  return { cluster: body.Cluster, taskArn: body.TaskARN };
}

/** Production wiring: identity from metadata v4 (retried, the endpoint can
 * lag the container start by a few seconds), control-plane probe through
 * @aws-sdk/client-ecs, metadata probe as the second path, one coordinator.
 * Never throws: a missing identity or SDK failure degrades to the metadata
 * path alone and is reported through onControlPlaneReadiness(false). */
export async function startDrainCoordinator(deps: {
  metadataUri: string;
  onDrain: (source: DrainSignalSourceName) => void;
  onControlPlaneReadiness?: (ready: boolean, reason?: unknown) => void;
  fetchImpl?: DrainFetch;
  intervalMs?: number;
  warn?: (message: string, reason: unknown) => void;
  /** Injectable for tests; default builds a DescribeTasks call on the SDK. */
  describeTask?: DescribeTaskDesiredStatus;
  identityAttempts?: number;
}): Promise<DrainCoordinator> {
  const warn = deps.warn ?? ((message: string, reason: unknown) => console.warn(`[Slock] ${message}:`, reason));
  const sources: DrainSignalSource[] = [createMetadataDrainSource({ metadataUri: deps.metadataUri, fetchImpl: deps.fetchImpl })];

  let identity: { cluster: string; taskArn: string } | undefined;
  const attempts = deps.identityAttempts ?? 6;
  for (let attempt = 1; attempt <= attempts && !identity; attempt += 1) {
    try {
      identity = await readEcsTaskIdentity({ metadataUri: deps.metadataUri, fetchImpl: deps.fetchImpl });
    } catch (err) {
      if (attempt === attempts) warn("Failed to read ECS task identity for the drain coordinator", err);
    }
    if (!identity && attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  if (identity) {
    try {
      const describeTask = deps.describeTask ?? (await createSdkDescribeTask(identity.taskArn));
      sources.unshift(createControlPlaneDrainSource({ cluster: identity.cluster, taskArn: identity.taskArn, describeTask }));
    } catch (err) {
      deps.onControlPlaneReadiness?.(false, err);
    }
  } else {
    deps.onControlPlaneReadiness?.(false, new Error("ECS task identity unavailable from metadata v4"));
  }

  const coordinator = createDrainCoordinator({
    sources,
    onDrain: deps.onDrain,
    intervalMs: deps.intervalMs,
    warn,
    onSourceReadiness: (source, ready, reason) => {
      if (source === "control_plane") deps.onControlPlaneReadiness?.(ready, reason);
    },
  });
  coordinator.start();
  return coordinator;
}

async function createSdkDescribeTask(taskArn: string): Promise<DescribeTaskDesiredStatus> {
  // Region from the task ARN (arn:aws:ecs:<region>:...): the task role's
  // credentials come from the container credential provider, the region is
  // not guaranteed to be in the environment.
  const region = taskArn.split(":")[3];
  const { ECSClient, DescribeTasksCommand } = await import("@aws-sdk/client-ecs");
  const client = new ECSClient(region ? { region } : {});
  return async ({ cluster, taskArn: arn, signal }) => {
    const output = await client.send(new DescribeTasksCommand({ cluster, tasks: [arn] }), { abortSignal: signal });
    const task = output.tasks?.find((t) => t.taskArn === arn) ?? output.tasks?.[0];
    if (!task) {
      const failure = output.failures?.[0];
      throw new Error(failure ? `DescribeTasks failure: ${failure.reason ?? "unknown"} (${failure.arn ?? arn})` : "DescribeTasks returned no task");
    }
    return { desiredStatus: task.desiredStatus, lastStatus: task.lastStatus };
  };
}
