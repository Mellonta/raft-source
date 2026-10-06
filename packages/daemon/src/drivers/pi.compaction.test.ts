import assert from "node:assert/strict";
import { AgentSession, SessionManager, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ParsedEvent } from "./types";
import { projectStructuredRuntimeTerminalFailure } from "../runtimeCompactionProjection";
import { createPiSdkEventMappingState, mapPiSdkEventToParsedEvents } from "./pi";

// Disposable SDK session state and deterministic summarizer; no provider or
// historical session access. Exercise the installed pi SDK's recovery methods.
function fixture(summaryError?: string) {
  const manager = SessionManager.inMemory();
  for (let i = 0; i < 12; i++) manager.appendMessage({
    role: "user", content: `synthetic-${i} ${"x".repeat(1000)}`, timestamp: i + 1,
  });
  const sdkEvents: AgentSessionEvent[] = [];
  const parsed: ParsedEvent[] = [];
  const state = createPiSdkEventMappingState("disposable-task1117");
  const model = { id: "deepseek-v4-flash", provider: "deepseek", contextWindow: 10000, maxTokens: 1000 };
  let calls = 0;
  const session = {
    _overflowRecoveryAttempted: false,
    model, sessionManager: manager,
    settingsManager: { getCompactionSettings: () => ({ enabled: true, reserveTokens: 1000, keepRecentTokens: 100 }) },
    agent: { state: { messages: manager.buildSessionContext().messages }, hasQueuedMessages: () => false },
    _extensionRunner: { hasHandlers: () => false, emit: async () => undefined },
    _entryIdsByMessage: new Map<unknown, string>(),
    _runDefaultCompaction: async (preparation: { firstKeptEntryId: string; tokensBefore: number }) => {
      calls++;
      if (summaryError) throw new Error(summaryError);
      return { summary: "synthetic summary", firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore };
    },
    _emitSessionCompactFailed: async () => undefined,
    _resolveIdleWaitIfIdle: () => undefined,
    _emit: (event: AgentSessionEvent) => {
      sdkEvents.push(event);
      parsed.push(...mapPiSdkEventToParsedEvents(event, state, {
        messageCount: session.agent.state.messages.length,
        inputTextLength: JSON.stringify(session.agent.state.messages).length,
        configuredContextLimit: model.contextWindow,
      }));
    },
  };
  // Private helpers the recovery methods call (context refresh, message-model lookup) come from
  // the real prototype; only the state and side effects above are stubbed.
  Object.setPrototypeOf(session, AgentSession.prototype);
  const methods = AgentSession.prototype as unknown as {
    _runAutoCompaction(reason: string, retry: boolean): Promise<boolean>;
    _checkCompaction(message: unknown): Promise<void>;
  };
  const run = (reason = "threshold", retry = false) => methods._runAutoCompaction.call(session, reason, retry);
  return { session, sdkEvents, parsed, run, methods, calls: () => calls };
}

test("summarizer input overflow ends with failed compaction before any finished event", async () => {
  const f = fixture("400: maximum context length exceeded");
  assert.equal(await f.run(), false);
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.sdkEvents.map(e => e.type), ["compaction_start", "compaction_end"]);
  const end = f.sdkEvents.find(e => e.type === "compaction_end");
  assert.match(end?.errorMessage ?? "", /maximum context length/);
  assert.equal(f.parsed.some(e => e.kind === "compaction_finished"), false);
  assert.equal(f.parsed.find(e => e.kind === "error")?.message, "InputTooLargeError");
  assert.equal(f.parsed.find(e => e.kind === "error")?.compaction?.failureReason, "input_too_large");
  assert.equal(f.parsed.some(e => e.kind === "compaction_interrupted"), false);
});

test("successful compaction then another overflow has finished before recovery exhausted", async () => {
  const f = fixture();
  assert.equal(await f.run("overflow", true), true);
  assert.equal(f.calls(), 1);
  f.session._overflowRecoveryAttempted = true;
  await f.methods._checkCompaction.call(f.session, {
    role: "assistant", provider: "deepseek", model: "deepseek-v4-flash",
    timestamp: Date.now() + 10000, stopReason: "error",
    errorMessage: "400: maximum context length exceeded",
  });
  assert.deepEqual(f.parsed.filter(e => ["compaction_finished", "error"].includes(e.kind)).map(e => e.kind),
    ["compaction_finished", "error"]);
  assert.equal(f.parsed.find(e => e.kind === "error")?.compaction?.failureReason, "recovery_exhausted");
  assert.equal(f.parsed.some(e => e.kind === "compaction_interrupted"), false);
});

test("unrelated summarizer service failure must not claim input too large", async () => {
  const f = fixture("503: synthetic summarizer service unavailable");
  assert.equal(await f.run("overflow"), false);
  assert.equal(f.calls(), 1);
  const end = f.sdkEvents.find(e => e.type === "compaction_end");
  assert.match(end?.errorMessage ?? "", /503/);
  assert.equal(f.parsed.find(e => e.kind === "error")?.compaction?.failureReason, "compaction_failed");
  assert.equal(f.parsed.some(e => e.kind === "compaction_interrupted"), false);
  assert.notEqual(f.parsed.find(e => e.kind === "error")?.message, "InputTooLargeError");
  const error = f.parsed.find(e => e.kind === "error");
  assert.ok(error);
  assert.deepEqual(error.compaction?.failureDiagnostic && {
    errorClass: error.compaction.failureDiagnostic.errorClass,
    errorReason: error.compaction.failureDiagnostic.errorReason,
    reasonProvenance: error.compaction.failureDiagnostic.reasonProvenance,
  }, {
    errorClass: "ProviderServerError",
    errorReason: "provider_server_error",
    reasonProvenance: "runtime_error_event",
  });
  assert.match(error.compaction?.failureDiagnostic?.fingerprint ?? "", /^[0-9a-f]{16}$/);
  assert.doesNotMatch(JSON.stringify(error), /503|synthetic|service unavailable/iu);
  const terminal = projectStructuredRuntimeTerminalFailure(error, "builtin");
  assert.ok(terminal);
  assert.match(terminal.detail, /compaction failed/);
  assert.doesNotMatch(terminal.detail, /input.*too large|503|synthetic/);
  assert.equal(terminal.actionRequired, false);
});

test("missing compaction error text stays explicitly absent", () => {
  const parsed = mapPiSdkEventToParsedEvents({
    type: "compaction_end",
    reason: "threshold",
    result: undefined,
    aborted: false,
    willRetry: false,
  } as unknown as AgentSessionEvent, createPiSdkEventMappingState("missing-error"));
  const error = parsed.find(event => event.kind === "error");
  assert.ok(error?.kind === "error");
  assert.equal(Object.hasOwn(error.compaction ?? {}, "failureDiagnostic"), false);
});

test("an exact operation abort diagnostic does not claim provider outage", () => {
  const parsed = mapPiSdkEventToParsedEvents({
    type: "compaction_end",
    reason: "threshold",
    result: undefined,
    aborted: false,
    willRetry: false,
    errorMessage: "This operation was aborted",
  } as unknown as AgentSessionEvent, createPiSdkEventMappingState("operation-abort"));
  const error = parsed.find(event => event.kind === "error");
  assert.ok(error?.kind === "error");
  assert.equal(error.compaction?.failureDiagnostic?.errorClass, "OperationAbortedError");
  assert.equal(error.compaction?.failureDiagnostic?.errorReason, "operation_aborted");
});
