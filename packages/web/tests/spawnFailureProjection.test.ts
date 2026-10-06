import assert from "node:assert/strict";
import { createIntl } from "react-intl";
import { mergedMessages } from "../src/i18n/messages/index";
import { formatActivityTextDescriptor, getActivityTextDescriptor } from "../src/utils/activity";
import { useAgentStore } from "../src/store/agentStore";

// task #1123 — the web must carry the daemon's typed spawn-failure reason and
// must not collapse a failed start into a bare "Offline".

test("offline + runtime_unavailable keeps the daemon's detail in the activity text", () => {
  const descriptor = getActivityTextDescriptor("offline", "Runtime start failed: model not found", "runtime_unavailable");
  assert.deepEqual(descriptor.primary, { raw: "Runtime start failed: model not found" });
  // A plain stop still uses the catalog copy.
  const stopped = getActivityTextDescriptor("offline", "", "stopped");
  assert.equal((stopped.primary as { id: string }).id, "activity.status.stoppedUnavailable");
});

test("model_not_found has dedicated copy in both catalogs that names the model", () => {
  for (const locale of ["en", "zh-cn"] as const) {
    const intl = createIntl({ locale, defaultLocale: "en", messages: mergedMessages(locale) });
    const text = formatActivityTextDescriptor(intl.formatMessage, {
      primary: { id: "activity.status.modelNotFound", values: { model: "claude-opus-5" } },
    });
    assert.ok(text.includes("claude-opus-5"), `${locale}: ${text}`);
    assert.ok(!text.includes("activity.status."), `${locale} copy must resolve`);
  }
});

test("the store keeps the spawnFailure carrier next to the activity state and clears it on the next plain activity", () => {
  const store = useAgentStore.getState();
  store.updateActivity(
    "agent-sf",
    "offline",
    "Runtime start failed",
    10,
    500,
    { launchId: "launch-1", clientSeq: 1 },
    "offline",
    "runtime_unavailable",
    { clientEventId: "evt-sf-1" },
    false,
    false,
    undefined,
    undefined,
    { reason: "model_not_found", model: "claude-opus-5" },
  );
  const state = useAgentStore.getState().agentActivities["agent-sf"];
  assert.equal(state?.detailKind, "runtime_unavailable");
  assert.deepEqual(state?.spawnFailure, { reason: "model_not_found", model: "claude-opus-5" });

  useAgentStore.getState().updateActivity("agent-sf", "working", "Running command", 11, 600, { launchId: "launch-2", clientSeq: 1 }, "working", "running_command");
  assert.equal(useAgentStore.getState().agentActivities["agent-sf"]?.spawnFailure, undefined, "a later plain activity drops the carrier");
});
