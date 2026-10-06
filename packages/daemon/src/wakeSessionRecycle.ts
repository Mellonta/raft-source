import { open, readdir, stat } from "node:fs/promises";
import os from "node:os";
import type { AgentConfig } from "@botiverse/raft-shared";
import { resolveRuntimeSessionRef } from "./drivers/index";
import { logger } from "./logger";
import type { AxSurfaceText } from "@botiverse/raft-shared";
import { axSurface, composeAxSurfaces } from "./agentRuntimeInput";
import { WAKE_SECTION_BREAK, buildStartupMemoryBlock, resolveStartupMemoryBlockConfig } from "./startupMemoryBlock";
import { buildConstructedPanel } from "./wakeBriefingPanel";

/**
 * At-wake session recycling (RFC 070, phase 1).
 *
 * When an agent wakes after its prompt cache has certainly expired AND its
 * previous runtime session carries a large context, resuming that session
 * makes the provider re-write the whole context at cache-write prices and
 * re-read it on every subsequent step. Starting a fresh session seeded with a
 * short reconstructed briefing is strictly cheaper and faster at the wake
 * boundary; the agent's durable state (MEMORY.md, notes/, Raft channels and
 * tasks) is unaffected.
 *
 * This module owns the decision and the briefing text. The only caller is
 * AgentProcessManager.startAgentNow, which applies the plan by clearing
 * `sessionId` before spawning (so the driver does not pass `--resume`) while
 * keeping the resume-shaped wake prompt ladder (catch-up messages and unread
 * summaries still deliver — they are the v0 constructed panel).
 *
 * Deliberately NOT here (deferred per RFC 070): at-cap recycling (compaction
 * stays the mid-turn backstop), the cold-idle process reaper, and the
 * block-provider panel architecture.
 */

/** Matches the 1h prompt-cache TTL measured across the fleet (RFC 070 §1):
 * past this gap the next request re-writes the resumed context in full, so
 * resuming a large session buys nothing that a fresh session does not. */
const DEFAULT_MIN_COLD_GAP_MS = 60 * 60_000;

/** RFC 070 §4: cost is insensitive to this threshold anywhere in 48k–256k
 * (cold-wake contexts are top-heavy); 128k keeps small, cheap-to-resume
 * sessions their continuity while capturing ~98.6% of the cold rewrite. */
const DEFAULT_MIN_CONTEXT_TOKENS = 128_000;

/** Bounded tail read of the session transcript; at the fleet's measured
 * ~1.4k tokens of growth per request this spans many turns, which is plenty
 * to find the last assistant usage record. */
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

/** RFC 070 §6.3 enabled set (decided 2026-09-03): recycling considers these
 * runtimes; everything else resumes as unsupported. Within the set, actually
 * firing additionally requires readable resume facts — today only the claude
 * transcript reader exists, so other members resolve to a facts-unavailable
 * resume until the daemon journal (§6.2) supplies their facts. */
export const WAKE_RECYCLE_ENABLED_RUNTIMES = new Set([
  "claude", "codex", "pi", "builtin", "grok", "kimi-sdk",
]);

export interface WakeRecycleConfig {
  enabled: boolean;
  minContextTokens: number;
  minColdGapMs: number;
}

export interface SessionResumeFacts {
  transcriptPath: string | null;
  lastActivityAtMs: number | null;
  lastContextTokens: number | null;
}

export type WakeRecyclePlan =
  | { action: "resume"; reason: string }
  | {
      action: "recycle";
      reason: "cold_gap_large_context";
      priorSessionId: string;
      idleMs: number;
      priorContextTokens: number;
      thresholds: { minContextTokens: number; minColdGapMs: number };
      briefing: AxSurfaceText;
    };

function parseBooleanFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "on") return true;
  if (normalized === "0" || normalized === "false" || normalized === "off" || normalized === "") return false;
  return undefined;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Rollout knobs. Recycling runs only when the server turned the
 * `constructed_wake_context` flag on for this agent's server
 * (`AgentConfig.constructedWakeContext`). Per-agent `agents.env_vars` win over
 * daemon process env for the tuning knobs, and RAFT_WAKE_RECYCLE=0 stays a
 * local kill switch; no env value can turn recycling on without the server flag.
 */
export function resolveWakeRecycleConfig(
  serverEnabled: boolean | null | undefined,
  agentEnvVars: Record<string, string> | null | undefined,
  processEnv: NodeJS.ProcessEnv = process.env,
): WakeRecycleConfig {
  const pick = (key: string): string | undefined => agentEnvVars?.[key] ?? processEnv[key];
  return {
    enabled: serverEnabled === true && parseBooleanFlag(pick("RAFT_WAKE_RECYCLE")) !== false,
    minContextTokens: parsePositiveInteger(pick("RAFT_WAKE_RECYCLE_MIN_CONTEXT_TOKENS")) ?? DEFAULT_MIN_CONTEXT_TOKENS,
    minColdGapMs: parsePositiveInteger(pick("RAFT_WAKE_RECYCLE_MIN_COLD_GAP_MS")) ?? DEFAULT_MIN_COLD_GAP_MS,
  };
}

function contextTokensFromUsage(usage: unknown): number | null {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const record = usage as Record<string, unknown>;
  const finite = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const total = finite(record.input_tokens)
    + finite(record.cache_read_input_tokens)
    + finite(record.cache_creation_input_tokens);
  return total > 0 ? total : null;
}

/**
 * Read the two facts the recycle decision needs from the tail of the Claude
 * session transcript: when the session last progressed, and how large its
 * context was on the last completed request. Any unreadable/missing fact
 * yields nulls, and the caller falls back to a plain resume.
 *
 * Reading the transcript (rather than tracking live state) makes the decision
 * correct across daemon restarts and costs one bounded file read per wake.
 */
export async function readClaudeSessionResumeFacts(
  sessionId: string,
  homeDir: string = os.homedir(),
): Promise<SessionResumeFacts> {
  const ref = resolveRuntimeSessionRef("claude", sessionId, homeDir);
  if (!ref.reachable || !ref.path) {
    return { transcriptPath: null, lastActivityAtMs: null, lastContextTokens: null };
  }
  try {
    const info = await stat(ref.path);
    const readStart = Math.max(0, info.size - TRANSCRIPT_TAIL_BYTES);
    const toRead = info.size - readStart;
    const buffer = Buffer.alloc(toRead);
    const fd = await open(ref.path, "r");
    try {
      let bytesRead = 0;
      while (bytesRead < toRead) {
        const result = await fd.read(buffer, bytesRead, toRead - bytesRead, readStart + bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
    } finally {
      await fd.close();
    }
    const lines = buffer.toString("utf8").split("\n");
    // A mid-file window starts inside a record; drop the leading fragment.
    if (readStart > 0) lines.shift();

    let lastActivityAtMs: number | null = null;
    let lastContextTokens: number | null = null;
    for (const line of lines) {
      if (!line) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      if (typeof record.timestamp === "string") {
        const parsed = Date.parse(record.timestamp);
        if (Number.isFinite(parsed)) lastActivityAtMs = Math.max(lastActivityAtMs ?? 0, parsed);
      }
      if (record.type === "assistant") {
        const message = record.message;
        if (message && typeof message === "object" && !Array.isArray(message)) {
          const tokens = contextTokensFromUsage((message as Record<string, unknown>).usage);
          if (tokens !== null) lastContextTokens = tokens;
        }
      }
    }
    return { transcriptPath: ref.path, lastActivityAtMs, lastContextTokens };
  } catch {
    return { transcriptPath: ref.path, lastActivityAtMs: null, lastContextTokens: null };
  }
}

export interface WakeRecycleDecisionInput {
  config: WakeRecycleConfig;
  runtime: string | undefined;
  sessionId: string | null | undefined;
  hasResumePrompt: boolean;
  hasRuntimeProfileControl: boolean;
  facts: SessionResumeFacts;
  nowMs: number;
}

/** A pending runtime-profile control blocks recycling only when it is a real
 * profile transition. A `daemon_release_notice` is just a message for the
 * agent (it re-delivers on the fresh session's ladder) — after every daemon
 * release the whole fleet carries one, and pinning giant transcripts for it
 * would suppress recycling exactly when it matters most. */
export function runtimeProfileControlBlocksRecycle(
  control: { kind: string } | null | undefined,
): boolean {
  return Boolean(control && control.kind !== "daemon_release_notice");
}

/** Facts dispatch per runtime (RFC 070 §6.2): claude reads its transcript
 * tail; every other enabled runtime reports unknown facts until the daemon
 * journal supplies them, which resolves to a conservative resume upstream. */
export async function readRuntimeSessionResumeFacts(
  runtime: string,
  sessionId: string,
  homeDir?: string,
): Promise<SessionResumeFacts> {
  if (runtime === "claude") return readClaudeSessionResumeFacts(sessionId, homeDir);
  return { transcriptPath: null, lastActivityAtMs: null, lastContextTokens: null };
}

/**
 * Pure decision core. Every gate that fails resolves to a plain resume with a
 * reason string; the transcript-derived facts must POSITIVELY establish both
 * "cache is certainly cold" and "context is large" before a session is
 * recycled. Unknown facts always mean resume.
 */
export function decideWakeRecycle(input: WakeRecycleDecisionInput): WakeRecyclePlan {
  const { config, facts } = input;
  if (!config.enabled) return { action: "resume", reason: "disabled" };
  if (!WAKE_RECYCLE_ENABLED_RUNTIMES.has(input.runtime ?? "claude")) return { action: "resume", reason: "unsupported_runtime" };
  if (!input.sessionId) return { action: "resume", reason: "no_prior_session" };
  if (input.hasResumePrompt) return { action: "resume", reason: "explicit_resume_prompt" };
  if (input.hasRuntimeProfileControl) return { action: "resume", reason: "runtime_profile_control" };
  if (facts.lastActivityAtMs === null || facts.lastContextTokens === null) {
    return { action: "resume", reason: "session_facts_unavailable" };
  }
  const idleMs = input.nowMs - facts.lastActivityAtMs;
  if (idleMs <= config.minColdGapMs) return { action: "resume", reason: "cache_possibly_warm" };
  if (facts.lastContextTokens <= config.minContextTokens) return { action: "resume", reason: "context_below_threshold" };
  return {
    action: "recycle",
    reason: "cold_gap_large_context",
    priorSessionId: input.sessionId,
    idleMs,
    priorContextTokens: facts.lastContextTokens,
    thresholds: { minContextTokens: config.minContextTokens, minColdGapMs: config.minColdGapMs },
    briefing: buildRecycleBriefing({ idleMs, priorContextTokens: facts.lastContextTokens }),
  };
}

/**
 * The recycled-wake first input carries NO announcement and NO instructions
 * (v2, 2026-09-11). The v1 chrome ("your session was retired… consult
 * MEMORY.md first, then re-establish state…") measurably framed every wake as
 * a resume-protocol: in the 13-recycle canary batch, 13/13 fresh sessions
 * opened with state-re-establishment rituals instead of the message that woke
 * them. A chat window never announces that its context was rebuilt — history
 * sits quietly above, the new message sits at the bottom, and the thread
 * itself carries any commitments. The constructed input now has that shape:
 * ambient blocks (memory, recent messages, in-flight facts) above, the
 * ordinary wake prompt last, nothing in between telling the agent what kind
 * of start this is or what to do first.
 */
export const buildRecycleBriefing = axSurface(
  "Recycled-wake briefing: intentionally EMPTY — the context blocks are XML-delimited and self-labeling, and any announcement or recap line reads as a protocol to follow",
  (args: { idleMs: number; priorContextTokens: number }): string => {
    void args;
    return "";
  },
  { examples: [{ title: "any recycle", args: [{ idleMs: 3 * 3_600_000, priorContextTokens: 500_000 }] }] },
);

/** Compose ax-surface pieces with the section break, skipping empty pieces so
 * an empty briefing contributes no leading blank lines. */
function composeWakeSections(...pieces: AxSurfaceText[]): AxSurfaceText {
  const nonEmpty = pieces.filter((piece) => String(piece).length > 0);
  let composed = nonEmpty[0] ?? pieces[pieces.length - 1]!;
  for (const piece of nonEmpty.slice(1)) composed = composeAxSurfaces(composed, WAKE_SECTION_BREAK, piece);
  return composed;
}

/** Trace payload + log line for an applied recycle, kept here so the
 * AgentProcessManager call site stays a thin hook. */
export function describeAppliedWakeRecycle(
  agentId: string,
  plan: Extract<WakeRecyclePlan, { action: "recycle" }>,
): { traceAttrs: Record<string, unknown>; logLine: string } {
  return {
    traceAttrs: {
      agentId,
      reason: plan.reason,
      prior_session_id: plan.priorSessionId,
      idle_ms: plan.idleMs,
      prior_context_tokens: plan.priorContextTokens,
      min_context_tokens: plan.thresholds.minContextTokens,
      min_cold_gap_ms: plan.thresholds.minColdGapMs,
    },
    logLine: `Retiring runtime session ${plan.priorSessionId} at wake (idle ${Math.round(plan.idleMs / 60_000)}m, ~${Math.round(plan.priorContextTokens / 1000)}k context); starting fresh with briefing`,
  };
}

/** How often the cold-idle sweep runs. The in-memory progress clock gates
 * candidates for free; the transcript is only read for processes already past
 * the cold gap, so a sweep over an idle fleet costs a handful of stats. */
export const COLD_IDLE_SWEEP_MS = 10 * 60_000;

export interface ColdIdleRuntimeView {
  agentId: string;
  config: AgentConfig;
  /** APM-idle AND nothing untold queued — never select a process with work
   * pending. Already-notified unread messages are the agent's own deferral and
   * do not count (see AgentProcessManager.hasUntoldInboxWork). */
  idle: boolean;
  /** Daemon's in-memory runtime-progress clock (RuntimeProgressState.lastEventAt). */
  lastEventAtMs: number;
  /** Live session id latched from the runtime (falls back to config.sessionId). */
  liveSessionId: string | null;
}

export interface ColdIdleRecycleStop {
  agentId: string;
  sessionId: string;
  idleMs: number;
  priorContextTokens: number;
}

/**
 * Pick idle runtime processes whose prompt cache has certainly expired and
 * whose context is past the recycle threshold. Keeping such a process alive
 * buys nothing (its cache is gone; only ~1s of respawn is saved), while
 * stopping it routes the next wake through the process-start path where the
 * at-wake recycle applies — this is how the recycle reaches the fleet's
 * dominant cold-wake shape (long-lived processes woken via stdin).
 */
export async function selectColdIdleRecycleStops(
  views: readonly ColdIdleRuntimeView[],
  opts: { nowMs?: number; homeDir?: string; processEnv?: NodeJS.ProcessEnv } = {},
): Promise<ColdIdleRecycleStop[]> {
  const nowMs = opts.nowMs ?? Date.now();
  const out: ColdIdleRecycleStop[] = [];
  for (const view of views) {
    const cfg = resolveWakeRecycleConfig(view.config.constructedWakeContext, view.config.envVars, opts.processEnv ?? process.env);
    if (!cfg.enabled || !view.idle) continue;
    if (!WAKE_RECYCLE_ENABLED_RUNTIMES.has(view.config.runtime ?? "claude")) continue;
    const sessionId = view.liveSessionId ?? view.config.sessionId;
    if (!sessionId) continue;
    if (nowMs - view.lastEventAtMs <= cfg.minColdGapMs) continue;
    const facts = await readRuntimeSessionResumeFacts(view.config.runtime ?? "claude", sessionId, opts.homeDir);
    if (facts.lastActivityAtMs === null || facts.lastContextTokens === null) continue;
    // A turn-idle runtime can still host live background work (subagents,
    // monitors) whose activity lands in the session's sidecar directory, not
    // the main transcript. Stopping mid-subagent loses that work — count the
    // sidecar's freshest mtime as activity. (Observed live: the sweep killed a
    // runtime whose Explore subagent was mid-flight.)
    const sidecarActivityAtMs = facts.transcriptPath
      ? await latestMtimeUnder(facts.transcriptPath.replace(/\.jsonl$/, ""))
      : null;
    const lastActive = Math.max(facts.lastActivityAtMs, view.lastEventAtMs, sidecarActivityAtMs ?? 0);
    if (nowMs - lastActive <= cfg.minColdGapMs) continue;
    if (facts.lastContextTokens <= cfg.minContextTokens) continue;
    // Sweep only sessions with DEFINITELY zero outstanding background tasks
    // right now: a runtime holding an armed monitor/background task may have
    // silent pending intent the daemon cannot see; leave it alone.
    if (!facts.transcriptPath) continue;
    const outstanding = await transcriptOutstandingBackgroundTasks(facts.transcriptPath);
    if (outstanding === null || outstanding > 0) continue;
    out.push({
      agentId: view.agentId,
      sessionId,
      idleMs: nowMs - lastActive,
      priorContextTokens: facts.lastContextTokens,
    });
  }
  return out;
}

/**
 * Static transcript markers that a session has EVER created background work
 * (background bash, Monitor, async subagents, task notifications). The live
 * `background_tasks_changed` roster is not persisted to the transcript, so the
 * sweep's "definitely no background business" gate is the conservative
 * complement: any marker ever seen disqualifies the session from sweeping.
 * Markers only ever accumulate in an append-only transcript, so the scan is
 * incremental: previously scanned bytes are never re-read, and a hit is final.
 */
const BACKGROUND_TASK_CREATE_PATTERNS = [
  /Monitor started \(task ([a-z0-9]+)/g,
  /background with ID: ([a-z0-9]+)/g,
  /moved to the background \(ID: ([a-z0-9]+)\)/g,
] as const;
const BACKGROUND_TASK_TERMINAL_PATTERNS = [
  /<task-id>([a-z0-9]+)<\/task-id>[\s\S]{0,400}?<status>(?:completed|failed|stopped|killed)<\/status>/g,
  /Successfully stopped task: ([a-z0-9]+)/g,
] as const;

interface BackgroundTaskScanState {
  scannedBytes: number;
  live: Set<string>;
}

const backgroundTaskScans = new Map<string, BackgroundTaskScanState>();
const MARKER_SCAN_CHUNK = 4 * 1024 * 1024;
const MARKER_OVERLAP = 512;

/**
 * Count background tasks (monitors, background bash, async subagents) that
 * were created in this transcript and have no terminal notification yet.
 * Fleet measurement (RFC 070): 95.7% of real cold wakes carry zero
 * outstanding tasks, so this paired accounting — versus "ever created any",
 * which only 12.5% pass — is what makes the sweep reach the fleet. The scan
 * is incremental over the append-only file with the live-set carried between
 * scans; an unmatched creation stays outstanding forever (fail-armed), and
 * read errors report null (unknown → the sweep must skip).
 */
export async function transcriptOutstandingBackgroundTasks(transcriptPath: string): Promise<number | null> {
  const state = backgroundTaskScans.get(transcriptPath) ?? { scannedBytes: 0, live: new Set<string>() };
  try {
    const info = await stat(transcriptPath);
    if (info.size <= state.scannedBytes) return state.live.size;
    const fd = await open(transcriptPath, "r");
    try {
      let position = Math.max(0, state.scannedBytes - MARKER_OVERLAP);
      const buffer = Buffer.alloc(MARKER_SCAN_CHUNK);
      while (position < info.size) {
        const { bytesRead } = await fd.read(buffer, 0, MARKER_SCAN_CHUNK, position);
        if (bytesRead === 0) break;
        const text = buffer.subarray(0, bytesRead).toString("utf8");
        for (const pattern of BACKGROUND_TASK_CREATE_PATTERNS) {
          for (const match of text.matchAll(pattern)) state.live.add(match[1]!);
        }
        for (const pattern of BACKGROUND_TASK_TERMINAL_PATTERNS) {
          for (const match of text.matchAll(pattern)) state.live.delete(match[1]!);
        }
        position += bytesRead;
      }
      state.scannedBytes = Math.max(state.scannedBytes, Math.min(position, info.size));
    } finally {
      await fd.close();
    }
    backgroundTaskScans.set(transcriptPath, state);
    return state.live.size;
  } catch {
    return null;
  }
}

/** Freshest mtime under a directory tree (one level of nesting is enough for
 * Claude session sidecars: subagents/, tasks/). Null when absent. */
async function latestMtimeUnder(dir: string): Promise<number | null> {
  let latest: number | null = null;
  const visit = async (target: string, depth: number): Promise<void> => {
    let info;
    try {
      info = await stat(target);
    } catch {
      return;
    }
    latest = Math.max(latest ?? 0, info.mtimeMs);
    if (!info.isDirectory() || depth >= 2) return;
    let entries: string[];
    try {
      entries = await readdir(target);
    } catch {
      return;
    }
    for (const entry of entries) {
      await visit(`${target}/${entry}`, depth + 1);
    }
  };
  await visit(dir, 0);
  return latest;
}

/** Prepend the briefing to the ladder-selected wake prompt and mark the
 * prompt source, as one atomic application so the call site stays one line. */
export function applyWakeRecycleBriefing(
  plan: WakeRecyclePlan,
  prompt: AxSurfaceText,
  promptSource: string,
): { prompt: AxSurfaceText; promptSource: string } {
  if (plan.action !== "recycle") return { prompt, promptSource };
  return { prompt: composeWakeSections(plan.briefing, prompt), promptSource: `recycled_${promptSource}` };
}

export interface PlanWakeSessionRecycleArgs {
  config: AgentConfig;
  hasResumePrompt: boolean;
  nowMs?: number;
  homeDir?: string;
  processEnv?: NodeJS.ProcessEnv;
}

/** Async entry point for AgentProcessManager: resolve knobs, read transcript
 * facts, decide. Never throws — any failure is a plain resume. */
export async function planWakeSessionRecycle(args: PlanWakeSessionRecycleArgs): Promise<WakeRecyclePlan> {
  const recycleConfig = resolveWakeRecycleConfig(args.config.constructedWakeContext, args.config.envVars, args.processEnv ?? process.env);
  if (!recycleConfig.enabled || !args.config.sessionId || !WAKE_RECYCLE_ENABLED_RUNTIMES.has(args.config.runtime ?? "claude")) {
    return decideWakeRecycle({
      config: recycleConfig,
      runtime: args.config.runtime,
      sessionId: args.config.sessionId,
      hasResumePrompt: args.hasResumePrompt,
      hasRuntimeProfileControl: runtimeProfileControlBlocksRecycle(args.config.runtimeProfileControl),
      facts: { transcriptPath: null, lastActivityAtMs: null, lastContextTokens: null },
      nowMs: args.nowMs ?? Date.now(),
    });
  }
  const facts = await readRuntimeSessionResumeFacts(args.config.runtime ?? "claude", args.config.sessionId, args.homeDir);
  const plan = decideWakeRecycle({
    config: recycleConfig,
    runtime: args.config.runtime,
    sessionId: args.config.sessionId,
    hasResumePrompt: args.hasResumePrompt,
    hasRuntimeProfileControl: runtimeProfileControlBlocksRecycle(args.config.runtimeProfileControl),
    facts,
    nowMs: args.nowMs ?? Date.now(),
  });
  if (plan.action === "resume") {
    // Enabled-but-resumed is the observable a canary needs: it says why the
    // recycle held its fire (warm cache, small context, missing facts, ...).
    logger.info(`[WakeRecycle] agent session ${args.config.sessionId} resumed: ${plan.reason} (lastActivityAtMs=${facts.lastActivityAtMs}, lastContextTokens=${facts.lastContextTokens}, path=${facts.transcriptPath ?? "none"})`);
    return plan;
  }
  // Constructed briefing order: briefing chrome, then the durable memory
  // index, then session-specific working state (panel). Both extras degrade
  // to absence, never block the recycle.
  let briefing = plan.briefing;

  // Startup memory block (RFC 070 §6 follow-up): a recycled start is a fresh
  // session, so the MEMORY.md head is pushed here instead of relying on the
  // standing-prompt read.
  const memoryConfig = resolveStartupMemoryBlockConfig(args.config.constructedWakeContext, args.config.envVars, args.processEnv ?? process.env);
  const workspacePath = args.config.runtimeContext?.workspacePath;
  if (memoryConfig.enabled && workspacePath) {
    const memoryBlock = await buildStartupMemoryBlock({ workspacePath, budgetTokens: memoryConfig.budgetTokens });
    if (memoryBlock) {
      briefing = composeWakeSections(briefing, memoryBlock);
      logger.info(`[WakeRecycle] startup memory block injected for recycled session ${plan.priorSessionId}`);
    }
  }

  // Constructed panel (RFC 070 §9 "v3"): open loops + objects in play (live
  // re-read where possible) + last actions, built from the retired session's
  // transcript. Failure to build degrades to the bare briefing, never blocks.
  const panelBudget = parsePositiveInteger(
    (args.config.envVars ?? undefined)?.RAFT_WAKE_RECYCLE_PANEL_TOKENS
      ?? (args.processEnv ?? process.env).RAFT_WAKE_RECYCLE_PANEL_TOKENS,
  ) ?? 8_000;
  // Recent-messages section knob: same env-family semantics, `=0` disables
  // just this section (the panel's other sections are unaffected).
  const recentMessagesRaw = (args.config.envVars ?? undefined)?.RAFT_WAKE_RECYCLE_RECENT_MESSAGES
    ?? (args.processEnv ?? process.env).RAFT_WAKE_RECYCLE_RECENT_MESSAGES;
  const recentMessagesMax = recentMessagesRaw?.trim() === "0" ? 0 : parsePositiveInteger(recentMessagesRaw);
  if (facts.transcriptPath && panelBudget > 0) {
    try {
      const panel = await buildConstructedPanel({
        transcriptPath: facts.transcriptPath,
        workspacePath: workspacePath ?? undefined,
        budgetTokens: panelBudget,
        recentMessagesMax,
      });
      if (panel) return { ...plan, briefing: composeWakeSections(briefing, panel) };
    } catch (err) {
      logger.warn(`[WakeRecycle] panel construction failed, using bare briefing: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return plan.briefing === briefing ? plan : { ...plan, briefing };
}
