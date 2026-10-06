// command.guidance (RFC 072 §7.4): an agent does not run a consequential
// command whose usage guidance it has not had in its current model context.
//
// - `--help` always prints the guidance in full, before Usage, and counts as
//   delivery once flushed.
// - Hold: the first run in a context does not execute. "Not executed" comes
//   first (truncation must never hide it), then the guidance — byte-identical
//   to the `--help` section — then the equivalent active command.
// - Attach: when delivery cannot be tracked or recorded, the command executes
//   and the guidance precedes its output on every run.
//
// Delivery is recorded from a stdout write callback (stdout flushed), under
// the contextId read when the decision was made.
import { createHash } from "node:crypto";

import type { Command } from "commander";

import {
  confirmPassiveDelivery,
  enabledContextSignal,
  decidePassiveDelivery,
  passiveAgentId,
  type AttachReason,
  type PassiveTouch,
} from "./passiveEngine";

/** Longest guidance a command may carry: it is printed on held and attached runs. */
export const MAX_GUIDANCE_LINES = 12;
export const MAX_GUIDANCE_CHARS = 1200;

type Stdout = Pick<NodeJS.WriteStream, "write">;

export const GUIDANCE_HOLD_HEADER =
  "Not executed: guidance for this command is new to this context. Read it, then run this raft command again unchanged. (GUIDANCE_DELIVERED)";

const ATTACH_HEADERS: Record<AttachReason, string> = {
  no_compaction_reports: "Executed. Guidance attached: this runtime does not report context compaction, so it is shown on every use.",
  ledger_unwritable: "Executed. Guidance attached: this agent's local record cannot be written, so it is shown on every use.",
};

/**
 * Guidance is printed whole on held and attached runs, so its size is a
 * contract, enforced where a command is registered: an oversized guidance
 * fails every test that builds the CLI, instead of being truncated at run time.
 */
export function assertGuidanceWithinLimits(commandName: string, guidance: string): void {
  const lines = guidance.split("\n").length;
  if (lines > MAX_GUIDANCE_LINES || guidance.length > MAX_GUIDANCE_CHARS) {
    throw new Error(
      `Guidance for "${commandName}" is ${lines} lines / ${guidance.length} characters; the limit is ${MAX_GUIDANCE_LINES} / ${MAX_GUIDANCE_CHARS}.`,
    );
  }
}

export function guidanceRev(guidance: string): string {
  return createHash("sha256").update(guidance).digest("hex").slice(0, 16);
}

export function commandPath(command: Command): string {
  const names: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent) names.unshift(current.name());
  return names.join(" ");
}

function touchFor(path: string, guidance: string): PassiveTouch {
  return { type: "command.guidance", id: path, rev: guidanceRev(guidance) };
}

/** `--help`: always the full guidance, before Usage; recorded once flushed. */
export function attachGuidanceToHelp(
  command: Command,
  guidance: string,
  options: { env?: NodeJS.ProcessEnv; stdout?: Stdout } = {},
): void {
  const env = options.env ?? process.env;
  let pending: { agentId: string; contextId: string } | null = null;
  command.addHelpText("before", () => {
    const agentId = passiveAgentId(env);
    // Printed regardless; booked only when passive AX is on for this launch.
    const signal = agentId ? enabledContextSignal(env) : undefined;
    pending = agentId && signal?.compactionReported
      ? { agentId, contextId: signal.contextId }
      : null;
    return `${guidance}\n`;
  });
  command.on("afterHelp", () => {
    const delivered = pending;
    pending = null;
    if (!delivered) return;
    const touch = touchFor(commandPath(command), guidance);
    // A failed write (EPIPE from `| head`, a closed pipe) delivered nothing:
    // record only when the flush succeeded.
    (options.stdout ?? process.stdout).write("", (error?: Error | null) => {
      if (!error) confirmPassiveDelivery(delivered.agentId, touch, delivered.contextId, env);
    });
  });
}

/**
 * Before the handler: "execute" (after writing the guidance first, in attach
 * mode) or "held" (the guidance was delivered instead; the caller raises
 * GUIDANCE_DELIVERED and nothing is sent).
 */
export function gateCommandGuidance(
  path: string,
  guidance: string,
  stdout: Stdout,
  env: NodeJS.ProcessEnv = process.env,
): "execute" | "held" {
  const agentId = passiveAgentId(env);
  const touch = touchFor(path, guidance);
  const decision = decidePassiveDelivery(agentId, touch, env);
  switch (decision.deliver) {
    case "pass":
      return "execute";
    case "attach":
      stdout.write(`${ATTACH_HEADERS[decision.reason]}\n${guidance}\n\n`);
      return "execute";
    case "hold":
      stdout.write(`${GUIDANCE_HOLD_HEADER}\n\n${guidance}\n\nEquivalent: raft ${path} --help\n`);
      stdout.write("", (error?: Error | null) => {
        if (!error) confirmPassiveDelivery(agentId, touch, decision.contextId, env);
      });
      return "held";
  }
}
