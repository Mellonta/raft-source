// Passive AX engine (RFC 072 §7): given a touched resource and its current
// rev, decide what to deliver from the registry policy, the agent's ledger,
// and the daemon's context signal. Knows no resource type by name; a new type
// is a registry row plus a call site that reports what it touched.
import fs from "node:fs";
import path from "node:path";

import {
  CONTEXT_GENERATION_FILENAME,
  CONTEXT_GENERATION_MAX_BYTES,
  type ContextGenerationRecord,
  isLocalStateAgentId,
  PASSIVE_RESOURCES,
  type PassiveResourceSpec,
  type PassiveResourceType,
} from "@botiverse/raft-shared";

import { probeLedgerWritable, readObservation, recordObservation } from "../state/agentLedger";

export interface PassiveTouch {
  type: PassiveResourceType;
  id: string;
  rev: string;
}

/** The daemon's signal for the model context this CLI runs in. */
export interface ContextSignal {
  contextId: string;
  /** False when the runtime compacts without telling the daemon. */
  compactionReported: boolean;
  /**
   * The passive-AX feature gate, composed by the daemon (server flag and its
   * `RAFT_PASSIVE_AX` kill switch) and written into the same record. Only a
   * literal `true` turns it on; missing (an older daemon) means off.
   */
  passiveAx: boolean;
}

export type AttachReason = "no_compaction_reports" | "ledger_unwritable";

export type PassiveDelivery =
  /** Act normally: already delivered in this context, or no policy host (no agent, no daemon). */
  | { deliver: "pass" }
  /** Deliver it and do not act; confirm with the `contextId` of this decision. */
  | { deliver: "hold"; contextId: string }
  /**
   * Act, and deliver it alongside, every time: delivery cannot be tracked or
   * recorded, and a hold that can never be released would never release.
   */
  | { deliver: "attach"; reason: AttachReason };

/** The agent the ledger is kept for, when the environment names a valid one. */
export function passiveAgentId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const agentId = env.SLOCK_AGENT_ID?.trim();
  return agentId && isLocalStateAgentId(agentId) ? agentId : undefined;
}

/**
 * `$SLOCK_CLI_TRANSPORT_DIR/context-generation`, written by the daemon for
 * this runtime launch. Trusted only as a regular file of this user, at most
 * 4 KiB, with a non-empty string `contextId`; anything else is "unknown".
 */
export function readContextSignal(transportDir: string): ContextSignal | undefined {
  let fd: number;
  try {
    fd = fs.openSync(path.join(transportDir, CONTEXT_GENERATION_FILENAME), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > CONTEXT_GENERATION_MAX_BYTES) return undefined;
    if (process.getuid && stat.uid !== process.getuid()) return undefined;
    const parsed = JSON.parse(fs.readFileSync(fd, "utf8")) as Partial<Record<keyof ContextGenerationRecord, unknown>>;
    if (typeof parsed.contextId !== "string" || parsed.contextId.length === 0) return undefined;
    return {
      contextId: parsed.contextId,
      compactionReported: parsed.compactionReported === true,
      passiveAx: (parsed as Record<string, unknown>).passiveAx === true,
    };
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The context signal, only when the daemon switched passive AX on for this
 * launch (task #359 gate; default off). No transport dir, an unreadable
 * record, or a record without `passiveAx: true` all mean off.
 */
export function enabledContextSignal(env: NodeJS.ProcessEnv): ContextSignal | undefined {
  const transportDir = env.SLOCK_CLI_TRANSPORT_DIR?.trim();
  if (!transportDir) return undefined;
  const signal = readContextSignal(transportDir);
  return signal?.passiveAx ? signal : undefined;
}

export function decidePassiveDelivery(
  agentId: string | undefined,
  touch: PassiveTouch,
  env: NodeJS.ProcessEnv = process.env,
): PassiveDelivery {
  // Widened on purpose: the engine dispatches on the policy, never the type.
  const spec: PassiveResourceSpec = PASSIVE_RESOURCES[touch.type];
  switch (spec.policy) {
    case "hold": {
      // RFC 072 §7.4, in order.
      if (!agentId) return { deliver: "pass" };
      // The feature gate comes first.
      const signal = enabledContextSignal(env);
      if (!signal) return { deliver: "pass" };
      if (!signal.compactionReported) return { deliver: "attach", reason: "no_compaction_reports" };
      const seen = readObservation(agentId, touch.type, touch.id, env);
      if (seen?.rev === touch.rev && seen.contextId === signal.contextId) return { deliver: "pass" };
      // Only hold when the release can be recorded afterwards.
      if (!probeLedgerWritable(agentId, env)) return { deliver: "attach", reason: "ledger_unwritable" };
      return { deliver: "hold", contextId: signal.contextId };
    }
  }
}

/**
 * Record that `touch` was delivered. Call only after stdout flushed, with the
 * contextId captured when the delivery was decided — never re-read here: if a
 * compaction started in between, the record must land under the old id
 * (delivered once more, the safe direction), not the new one.
 */
export function confirmPassiveDelivery(
  agentId: string | undefined,
  touch: PassiveTouch,
  contextId: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!agentId) return;
  recordObservation(agentId, touch.type, touch.id, touch.rev, contextId, env);
}
