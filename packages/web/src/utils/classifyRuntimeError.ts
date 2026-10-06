import type { MessageId } from "../i18n/messages";

// Runtime-error classification (@Wug boundary 2026-08-04): only enumerable,
// stable patterns are recognized and mapped to catalog copy; anything else
// stays null so the caller falls back to the generic message (or the raw
// diagnostic in the creator debug view). We never substring-translate
// arbitrary server English.

// `toolArgsInvalid` (task #1127) is reachable only from the daemon's typed
// carrier, never from `classifyRuntimeError` below: the upstream sentence is
// matched once in the daemon, and the web must not grow a second text matcher
// for the same fact.
export type RuntimeErrorKind = "notLoggedIn" | "notInstalled" | "authFailed" | "toolArgsInvalid";

const PATTERNS: readonly { kind: RuntimeErrorKind; re: RegExp }[] = [
  { kind: "notLoggedIn", re: /is not logged in/i },
  { kind: "notInstalled", re: /not installed/i },
  { kind: "authFailed", re: /(?:auth(?:entication|orization)? (?:failed|error|invalid)|invalid api key|unauthorized)/i },
];

export function classifyRuntimeError(message: string): RuntimeErrorKind | null {
  for (const { kind, re } of PATTERNS) {
    if (re.test(message)) return kind;
  }
  return null;
}

export const RUNTIME_ERROR_LABEL_ID: Record<RuntimeErrorKind, MessageId> = {
  notLoggedIn: "agent.runtimeError.notLoggedIn",
  notInstalled: "agent.runtimeError.notInstalled",
  authFailed: "agent.runtimeError.authFailed",
  toolArgsInvalid: "agent.runtimeError.toolArgsInvalid",
};
