import assert from "node:assert/strict";
import { createIntl } from "react-intl";
import { mergedMessages } from "../src/i18n/messages/index";
import { formatActivityTextDescriptor, getActivityTextDescriptor } from "../src/utils/activity";
import { useAgentStore } from "../src/store/agentStore";

// task #1116 — the web must render and retain the daemon's typed
// "deliveries written, runtime not consuming" state. Observation only.

const carrier = {
  launchId: "launch-1",
  episode: 1,
  unconsumedDeliveries: 3,
  firstUnconsumedAtMs: 1_000,
  lastDeliveryAtMs: 3_000,
  lastDeliveryKey: "msg-3",
  lastDeliveryPath: "stdin_idle_delivery",
  lastConsumptionKind: null,
  lastConsumptionAtMs: null,
  lastRuntimeResult: null,
  lastDeliveryErrorClass: null,
  processAlive: true,
} as const;

test("delivery_unconsumed has dedicated copy in both catalogs and the descriptor uses it", () => {
  const descriptor = getActivityTextDescriptor("online", "", "delivery_unconsumed" as never);
  assert.ok("id" in descriptor.primary, "a catalog message id, not raw detail");
  assert.equal((descriptor.primary as { id: string }).id, "activity.status.deliveryUnconsumed");
  for (const locale of ["en", "zh-cn"] as const) {
    const intl = createIntl({ locale, defaultLocale: "en", messages: mergedMessages(locale) });
    const text = formatActivityTextDescriptor(intl.formatMessage, descriptor);
    assert.ok(text.length > 0 && !text.includes("activity.status."), `${locale} copy must resolve`);
  }
});

test("the store keeps the deliveryConsumption carrier next to the activity state, and clears it on the next plain activity", () => {
  const store = useAgentStore.getState();
  store.updateActivity(
    "agent-1",
    "online",
    "3 deliveries written, runtime not consuming",
    10,
    500,
    { launchId: "launch-1", clientSeq: 7 },
    "online",
    "delivery_unconsumed",
    { clientEventId: "evt-1" },
    false,
    false,
    carrier,
  );
  const state = useAgentStore.getState().agentActivities["agent-1"];
  assert.equal(state?.detailKind, "delivery_unconsumed");
  assert.deepEqual(state?.deliveryConsumption, carrier);

  useAgentStore.getState().updateActivity("agent-1", "working", "Running command", 11, 600, { launchId: "launch-1", clientSeq: 8 }, "working", "running_command");
  assert.equal(useAgentStore.getState().agentActivities["agent-1"]?.deliveryConsumption, undefined, "a later plain activity drops the carrier");
});
