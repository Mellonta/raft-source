import assert from "node:assert/strict";

import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";

import { createAgentAppInboxStore } from "./agentAppInbox";
import { AgentProcessManager } from "./agentProcessManager";
import { REMINDER_AGENT_INBOX_REGISTRY } from "./apps/reminder/inboxDefinition";
import { traceRows } from "./testing/traceRows";

test("real AgentProcessManager wake uses the typed Inbox source correlation", async () => {
  const ownerAgentId = "agent-a";
  const store = createAgentAppInboxStore({
    registry: REMINDER_AGENT_INBOX_REGISTRY,
  });
  const minted = store.mint({
    appId: "system.reminder",
    notificationClass: "due",
    sourceRef: {
      kind: "reminder",
      id: "11111111-1111-4111-8111-111111111111",
      revision: "7",
    },
  });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;

  const sink = new MemoryTraceSink();
  const manager = new AgentProcessManager(
    () => {},
    "sk_machine_test",
    {
      serverUrl: "https://daemon.invalid",
      tracer: new BasicTracer({ sink }),
      appInboxForAgent: () => store,
    },
  );

  // No process and no restart snapshot: since task #1103 the wake is handed to
  // the Server instead of being reported as a dead end.
  assert.equal(await manager.notifyAgentAppInbox(ownerAgentId, minted.item), true);
  const wake = traceRows(sink).find((span) =>
    span.name === "daemon.agent.app_inbox_notice"
  );
  assert.equal(wake?.attrs?.outcome, "server_wake_requested");
  assert.equal(wake?.status, "ok");
  assert.equal(
    wake?.attrs?.app_correlation_id,
    `source:${ownerAgentId}:reminder:${minted.item.sourceRef.id}:7`,
  );
  assert.equal(wake?.attrs?.item_id, minted.item.itemId);
});
