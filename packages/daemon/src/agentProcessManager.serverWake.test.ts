import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BasicTracer, MemoryTraceSink, type MachineToServerMessage } from "@botiverse/raft-shared";
import { runWithActiveSpan } from "@botiverse/raft-trace-client";
import { createAgentAppInboxStore } from "./agentAppInbox";
import { AgentProcessManager } from "./agentProcessManager";
import { REMINDER_AGENT_INBOX_REGISTRY } from "./apps/reminder/inboxDefinition";
import { traceRows } from "./testing/traceRows";

// task #1103 — a due reminder for an idle agent with no local process and no
// in-memory restart snapshot (the state every idle agent is in after a daemon
// restart or upgrade) must hand the wake to the Server, which owns the agent
// config, instead of retrying locally until exhaustion.

const OWNER = "agent-a";

function harness(opts: { connected?: boolean } = {}) {
  const store = createAgentAppInboxStore({ registry: REMINDER_AGENT_INBOX_REGISTRY });
  const sent: MachineToServerMessage[] = [];
  const sink = new MemoryTraceSink();
  const dataDir = mkdtempSync(join(tmpdir(), "server-wake-agents-"));
  const manager = new AgentProcessManager(
    (msg) => { sent.push(msg); },
    "sk_machine_test",
    {
      dataDir,
      serverUrl: "https://daemon.invalid",
      tracer: new BasicTracer({ sink }),
      appInboxForAgent: () => store,
      serverConnected: () => opts.connected ?? true,
    },
  );
  const mint = (revision: string) => {
    const minted = store.mint({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: { kind: "reminder", id: "11111111-1111-4111-8111-111111111111", revision },
    });
    assert.equal(minted.ok, true);
    if (!minted.ok) throw new Error("mint failed");
    return minted.item;
  };
  const notices = () => traceRows(sink).filter((span) => span.name === "daemon.agent.app_inbox_notice");
  const wakeRequests = () => sent.filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:wake:request" }> =>
    msg.type === "agent:wake:request");
  /** Files under the agents data dir; the parked wake must never be one of them. */
  const filesOnDisk = () => readdirSync(dataDir, { recursive: true }) as string[];
  const cleanup = () => rmSync(dataDir, { recursive: true, force: true });
  return { store, sent, sink, manager, mint, notices, wakeRequests, filesOnDisk, cleanup };
}

test("no process and no restart snapshot: the due item becomes exactly one server wake request", async () => {
  const h = harness();
  const item = h.mint("7");

  assert.equal(await h.manager.notifyAgentAppInbox(OWNER, item), true);

  const requests = h.wakeRequests();
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.agentId, OWNER);
  assert.equal(requests[0]!.reason, "app_inbox_notice");
  assert.equal(requests[0]!.appId, "system.reminder");
  assert.deepEqual(requests[0]!.sourceRef, item.sourceRef);
  assert.equal(requests[0]!.pendingAppItems, 1);
  assert.match(requests[0]!.wakeRequestId, /^[0-9a-f]{32}$/u);
  const notice = h.notices().at(-1);
  assert.equal(notice?.attrs?.outcome, "server_wake_requested");
  assert.equal(notice?.status, "ok");

  // A duplicate fire for the same item is idempotent: same id, no second send.
  assert.equal(await h.manager.notifyAgentAppInbox(OWNER, item), true);
  assert.equal(h.wakeRequests().length, 1);
  assert.equal(h.notices().at(-1)?.attrs?.outcome, "server_wake_pending");

  // The parked request lives in memory only: no config, credentials or
  // snapshot is written for it (task #1103 acceptance boundary).
  assert.deepEqual(h.filesOnDisk(), []);
  h.cleanup();
});

test("an advisory notice never wakes a stopped agent and leaves the item for its next wake", async () => {
  const h = harness();
  const item = h.mint("7");

  assert.equal(await h.manager.notifyAgentAppInbox(OWNER, item, { startStoppedAgent: false }), true);

  assert.equal(h.wakeRequests().length, 0, "no server wake for an advisory item");
  assert.equal(h.notices().at(-1)?.attrs?.outcome, "advisory_not_running");
  assert.deepEqual(h.store.list().map((listed) => listed.itemId), [item.itemId]);

  // Not marked delivered: a later ordinary notice still asks for the wake.
  assert.equal(await h.manager.notifyAgentAppInbox(OWNER, item), true);
  assert.equal(h.wakeRequests().length, 1);
  h.cleanup();
});

test("the wake request id is stable across daemon restarts for the same due item", async () => {
  const a = harness();
  const b = harness();
  await a.manager.notifyAgentAppInbox(OWNER, a.mint("7"));
  await b.manager.notifyAgentAppInbox(OWNER, b.mint("7"));
  assert.equal(a.wakeRequests()[0]!.wakeRequestId, b.wakeRequests()[0]!.wakeRequestId);
  await a.manager.notifyAgentAppInbox(OWNER, a.mint("8"));
  assert.equal(a.wakeRequests().length, 2);
  assert.notEqual(a.wakeRequests()[1]!.wakeRequestId, a.wakeRequests()[0]!.wakeRequestId);
});

test("server unreachable: the request is parked, never retried locally, and resent once on reconnect", async () => {
  const h = harness({ connected: false });
  const item = h.mint("7");
  assert.equal(await h.manager.notifyAgentAppInbox(OWNER, item), true);
  assert.equal(h.notices().at(-1)?.attrs?.outcome, "server_wake_queued_offline");
  // Nothing reaches the socket while offline; the pending slot holds it.
  assert.equal(h.wakeRequests().length, 0);

  h.manager.resendPendingServerWakes();
  h.manager.resendPendingServerWakes();
  assert.equal(h.wakeRequests().length, 2, "one resend per connect edge, no local timer loop");
  assert.equal(h.wakeRequests()[0]!.wakeRequestId, h.wakeRequests()[1]!.wakeRequestId);
});

test("a refused outcome is a typed, visible end: pending cleared, item kept, next fire asks again", async () => {
  const h = harness();
  const item = h.mint("7");
  await h.manager.notifyAgentAppInbox(OWNER, item);
  const { wakeRequestId } = h.wakeRequests()[0]!;

  h.manager.handleServerWakeOutcome({
    type: "agent:wake:outcome",
    agentId: OWNER,
    wakeRequestId,
    outcome: "refused",
    reason: "manual_stop",
  });
  const outcome = traceRows(h.sink).find((span) => span.name === "daemon.agent.server_wake.outcome");
  assert.equal(outcome?.attrs?.outcome, "refused");
  assert.equal(outcome?.attrs?.reason, "manual_stop");
  assert.equal(outcome?.status, "error");
  assert.equal(h.store.list().length, 1, "the due item stays visible for `raft inbox check`");

  await h.manager.notifyAgentAppInbox(OWNER, item);
  assert.equal(h.wakeRequests().length, 2, "after a refusal the next fire may ask again");
});

test("a dispatched outcome settles the pending slot without touching the inbox", async () => {
  const h = harness();
  const item = h.mint("7");
  await h.manager.notifyAgentAppInbox(OWNER, item);
  h.manager.handleServerWakeOutcome({
    type: "agent:wake:outcome",
    agentId: OWNER,
    wakeRequestId: h.wakeRequests()[0]!.wakeRequestId,
    outcome: "dispatched",
  });
  const outcome = traceRows(h.sink).find((span) => span.name === "daemon.agent.server_wake.outcome");
  assert.equal(outcome?.attrs?.outcome, "dispatched");
  assert.equal(outcome?.status, "ok");
  h.manager.resendPendingServerWakes();
  assert.equal(h.wakeRequests().length, 1, "nothing pending to resend");
});

test("an outcome for an unknown request id is ignored, not applied to the live pending request", async () => {
  const h = harness();
  const item = h.mint("7");
  await h.manager.notifyAgentAppInbox(OWNER, item);
  h.manager.handleServerWakeOutcome({
    type: "agent:wake:outcome",
    agentId: OWNER,
    wakeRequestId: "0".repeat(32),
    outcome: "refused",
    reason: "agent_not_found",
  });
  h.manager.resendPendingServerWakes();
  assert.equal(h.wakeRequests().length, 2, "the real request is still pending and is resent");
});

test("a start already queued or in flight locally is not woken twice", async () => {
  const h = harness();
  const item = h.mint("7");
  (h.manager as unknown as { agentStarts: { markStarting(agentId: string): void } })
    .agentStarts.markStarting(OWNER);
  assert.equal(await h.manager.notifyAgentAppInbox(OWNER, item), false);
  assert.equal(h.wakeRequests().length, 0);
  assert.equal(h.notices().at(-1)?.attrs?.outcome, "not_idle");
});

test("a wake request sent under an active span carries its traceparent and the notice joins the trace", async () => {
  const h = harness();
  const item = h.mint("7");
  const tracer = new BasicTracer({ sink: h.sink });
  const fire = tracer.startSpan("daemon.app_source.fire", { surface: "daemon" });

  assert.equal(await runWithActiveSpan(fire, () => h.manager.notifyAgentAppInbox(OWNER, item)), true);
  fire.end("ok");

  const request = h.wakeRequests()[0]!;
  assert.equal(request.traceparent, `00-${fire.context.traceId}-${fire.context.spanId}-${fire.context.traceFlags}`);
  const notice = h.notices().at(-1)!;
  assert.equal(notice.attrs?.outcome, "server_wake_requested");
  assert.equal(notice.context.traceId, fire.context.traceId);
  assert.equal(notice.context.parentSpanId, fire.context.spanId);

  // Outside any active span the request stays a root and carries no traceparent.
  const h2 = harness();
  assert.equal(await h2.manager.notifyAgentAppInbox(OWNER, h2.mint("8")), true);
  assert.equal(h2.wakeRequests()[0]!.traceparent, undefined);
  assert.equal(h2.notices().at(-1)!.context.parentSpanId, null);
  h.cleanup();
  h2.cleanup();
});

test("a wake parked offline keeps the traceparent it was created under and resends it", async () => {
  const h = harness({ connected: false });
  const item = h.mint("7");
  const tracer = new BasicTracer({ sink: h.sink });
  const fire = tracer.startSpan("daemon.app_source.fire", { surface: "daemon" });
  assert.equal(await runWithActiveSpan(fire, () => h.manager.notifyAgentAppInbox(OWNER, item)), true);
  fire.end("ok");
  assert.equal(h.wakeRequests().length, 0);

  h.manager.resendPendingServerWakes();

  assert.equal(h.wakeRequests().length, 1);
  assert.equal(h.wakeRequests()[0]!.traceparent, `00-${fire.context.traceId}-${fire.context.spanId}-${fire.context.traceFlags}`);
  h.cleanup();
});
