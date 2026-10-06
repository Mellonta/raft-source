// Context generation signal, daemon side (RFC 072 §7.2).
//
// Before each runtime spawn and at every `compaction_started`, the daemon
// writes `$SLOCK_CLI_TRANSPORT_DIR/context-generation`. The CLI counts
// guidance as "seen" only while the id it recorded still matches, so any
// fresh spawn or compaction teaches it again.
//
// A compaction or a fresh spawn always writes a NEW id, so a late event from
// an old process (whose transport directory may be shared with the current
// one: the directory is keyed by launchId, and a launch-less spawn falls back
// to the daemon pid) can only cause one extra teaching, never a false "seen".
//
// Resume is not a new context (tygg, #proj-aiax:915fd5fa): a spawn that
// resumes a runtime session reuses the id that session last had, from an
// agent-level sessions table next to the launch directories. The table only
// learns a binding from the runtime's own `session_init`, and every doubt
// (missing, unreadable or unwritable table, a runtime that reports another
// session than the one resumed) resolves to a new id.
//
// Failure direction: the old file is removed before the new one is written.
// If the write fails, no file is left behind, so the CLI reads "signal
// unknown" and falls back to attaching the guidance. Leaving the previous
// spawn's id in place would let the CLI match it against old observations,
// which is exactly the false "seen" this signal exists to prevent.
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  CONTEXT_GENERATION_FILENAME,
  CONTEXT_GENERATION_MAX_BYTES,
  type ContextGenerationReason,
  type ContextGenerationRecord,
} from "@botiverse/raft-shared";

import { logger } from "./logger";

/**
 * Whether each registered runtime reports context compaction
 * (`compaction_started` / `compaction_finished`). Checked against every
 * registered driver by a test, so adding a driver forces an answer here.
 */
export const RUNTIME_REPORTS_COMPACTION: Readonly<Record<string, boolean>> = {
  // claudeEventNormalizer, codexEventNormalizer, cursor.ts, kimi.ts,
  // kimi-sdk.ts and pi.ts emit the normalized compaction events; builtin
  // extends the pi driver.
  claude: true,
  codex: true,
  cursor: true,
  kimi: true,
  "kimi-sdk": true,
  pi: true,
  builtin: true,
  // These runtimes never emit a compaction event, so an unchanged id says
  // nothing about whether their context was compacted.
  grok: false,
  copilot: false,
  gemini: false,
  opencode: false,
  antigravity: false,
};

/**
 * The composed passive AX gate on a spawn config (task #359). Only an explicit
 * `true` turns it on; a config from an older Server has no field and reads as
 * off.
 */
export function configPassiveAx(config: object): boolean {
  return (config as { passiveAx?: unknown }).passiveAx === true;
}

export function runtimeReportsCompaction(runtime: string): boolean {
  return RUNTIME_REPORTS_COMPACTION[runtime] === true;
}

export interface ContextGenerationFs {
  readFileSync: typeof readFileSync;
  writeFileSync: typeof writeFileSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
}

const DEFAULT_FS: ContextGenerationFs = { readFileSync, writeFileSync, renameSync, unlinkSync };

/** Agent-level table of the context id each runtime session last had. */
export const CONTEXT_SESSIONS_FILENAME = "sessions.json";
export const MAX_REMEMBERED_SESSIONS = 32;

interface ContextSessionsTable {
  version: 1;
  sessions: Record<string, { contextId: string; updatedAt: string }>;
}

type ContextGenerationDeps = { fs?: ContextGenerationFs; now?: () => Date; newId?: () => string };

function unlinkIfPresent(fs: ContextGenerationFs, file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
  }
}

/**
 * Publish a fresh context id into `transportDir`. Never throws: a failure is
 * logged and leaves no generation file (the safe "signal unknown" state).
 * Returns the id written, or null when nothing could be written.
 */
export function writeContextGeneration(
  transportDir: string,
  input: { reason: ContextGenerationReason; runtime: string; passiveAx: boolean; contextId?: string },
  deps: ContextGenerationDeps = {},
): string | null {
  const fs = deps.fs ?? DEFAULT_FS;
  const file = path.join(transportDir, CONTEXT_GENERATION_FILENAME);
  const record: ContextGenerationRecord = {
    contextId: input.contextId ?? (deps.newId ?? randomUUID)(),
    reason: input.reason,
    compactionReported: runtimeReportsCompaction(input.runtime),
    runtime: input.runtime,
    writtenAt: (deps.now?.() ?? new Date()).toISOString(),
    passiveAx: input.passiveAx,
  };
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // Remove the previous id first: if anything below fails, the CLI must
    // find no file rather than a stale id it could match.
    unlinkIfPresent(fs, file);
    fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
    return record.contextId;
  } catch (error) {
    try {
      unlinkIfPresent(fs, tmp);
      unlinkIfPresent(fs, file);
    } catch (cleanupError) {
      logger.warn(`[ContextGeneration] could not clear ${file} after a failed write: ${String(cleanupError)}`);
    }
    logger.warn(`[ContextGeneration] failed to write ${input.reason} generation: ${String(error)}`);
    return null;
  }
}

/** The record currently published in `transportDir`, or null if absent or unreadable. */
export function readContextGeneration(transportDir: string, deps: ContextGenerationDeps = {}): ContextGenerationRecord | null {
  const fs = deps.fs ?? DEFAULT_FS;
  try {
    const raw = fs.readFileSync(path.join(transportDir, CONTEXT_GENERATION_FILENAME), "utf8");
    if (raw.length > CONTEXT_GENERATION_MAX_BYTES) return null;
    const record = JSON.parse(raw) as Partial<ContextGenerationRecord> | null;
    return typeof record?.contextId === "string" && record.contextId ? (record as ContextGenerationRecord) : null;
  } catch {
    return null;
  }
}

/**
 * Spawn-time write. Resuming `resumeSessionId` reuses the id that session last
 * had; otherwise (fresh spawn, unknown session, or a runtime whose unchanged id
 * would prove nothing because it never reports compaction) a new id.
 */
export function publishSpawnContextGeneration(
  transportDir: string,
  input: { runtime: string; resumeSessionId?: string | null; passiveAx: boolean },
  deps: ContextGenerationDeps = {},
): string | null {
  const reused = input.resumeSessionId && runtimeReportsCompaction(input.runtime)
    ? readSessions(transportDir, deps)?.sessions[input.resumeSessionId]?.contextId
    : undefined;
  return reused
    ? writeContextGeneration(transportDir, { reason: "resume", runtime: input.runtime, passiveAx: input.passiveAx, contextId: reused }, deps)
    : writeContextGeneration(transportDir, { reason: "spawn", runtime: input.runtime, passiveAx: input.passiveAx }, deps);
}

/**
 * The runtime reported `sessionId` via `session_init`. Binds the published id
 * to it, or — when the runtime reports a different session than the one this
 * process started on (`expectedSessionId`: a failed resume that silently
 * started fresh, or a new conversation) — publishes a new id first.
 */
export function bindContextGenerationToSession(
  transportDir: string,
  input: { runtime: string; sessionId: string; expectedSessionId: string | null },
  deps: ContextGenerationDeps = {},
): void {
  const current = readContextGeneration(transportDir, deps);
  let contextId = current?.contextId ?? null;
  if (current && contextId && input.expectedSessionId && input.expectedSessionId !== input.sessionId) {
    // Same process, same gate: carry the published value over to the new id.
    contextId = writeContextGeneration(transportDir, { reason: "spawn", runtime: input.runtime, passiveAx: current.passiveAx === true }, deps);
  }
  rememberSessionContext(transportDir, input.sessionId, contextId, deps);
}

/**
 * Record (or, with `contextId` null, forget) the id `sessionId` last had. On a
 * failed write the whole table is removed: a stale entry would let a later
 * resume reuse a pre-compaction id, while no table only costs a new id.
 */
export function rememberSessionContext(
  transportDir: string,
  sessionId: string,
  contextId: string | null,
  deps: ContextGenerationDeps = {},
): void {
  const fs = deps.fs ?? DEFAULT_FS;
  const file = sessionsFile(transportDir);
  const table: ContextSessionsTable = readSessions(transportDir, deps) ?? { version: 1, sessions: {} };
  if (!contextId && !(sessionId in table.sessions)) return;
  delete table.sessions[sessionId];
  if (contextId) {
    table.sessions[sessionId] = { contextId, updatedAt: (deps.now?.() ?? new Date()).toISOString() };
    const entries = Object.entries(table.sessions);
    if (entries.length > MAX_REMEMBERED_SESSIONS) {
      // Insertion order is recency order: every update deletes then re-adds.
      table.sessions = Object.fromEntries(entries.slice(-MAX_REMEMBERED_SESSIONS));
    }
  }
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(table)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkIfPresent(fs, tmp);
      unlinkIfPresent(fs, file);
    } catch (cleanupError) {
      logger.warn(`[ContextGeneration] could not clear ${file} after a failed write: ${String(cleanupError)}`);
    }
    logger.warn(`[ContextGeneration] failed to update session table: ${String(error)}`);
  }
}

function sessionsFile(transportDir: string): string {
  // transportDir is <slockHome>/cli-transport/<agentId>/<launch part>.
  return path.join(path.dirname(transportDir), CONTEXT_SESSIONS_FILENAME);
}

function readSessions(transportDir: string, deps: ContextGenerationDeps): ContextSessionsTable | null {
  const fs = deps.fs ?? DEFAULT_FS;
  try {
    const table = JSON.parse(fs.readFileSync(sessionsFile(transportDir), "utf8")) as Partial<ContextSessionsTable> | null;
    if (table?.version !== 1 || typeof table.sessions !== "object" || table.sessions === null) return null;
    const sessions: ContextSessionsTable["sessions"] = {};
    for (const [sessionId, entry] of Object.entries(table.sessions)) {
      if (typeof entry?.contextId === "string" && entry.contextId) sessions[sessionId] = entry;
    }
    return { version: 1, sessions };
  } catch {
    return null;
  }
}
