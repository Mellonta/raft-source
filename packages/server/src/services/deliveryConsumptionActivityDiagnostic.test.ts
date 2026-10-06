import assert from "node:assert/strict";
import { normalizeDeliveryConsumptionActivityDiagnostic } from "./deliveryConsumptionActivityDiagnostic";

// task #1116 — the server passes the daemon carrier through unchanged, so the
// normalizer is the only guard between a daemon frame and the web payload.

const valid = {
  launchId: "launch-1",
  episode: 1,
  unconsumedDeliveries: 3,
  firstUnconsumedAtMs: 1_000,
  lastDeliveryAtMs: 3_000,
  lastDeliveryKey: "msg-3",
  lastDeliveryPath: "stdin_idle_delivery",
  lastConsumptionKind: null,
  lastConsumptionAtMs: null,
  lastRuntimeResult: { kind: "error", atMs: 500, errorClass: "TimeoutError" },
  lastDeliveryErrorClass: null,
  processAlive: true,
};

test("a well-formed carrier is returned field-for-field and nothing extra leaks through", () => {
  const normalized = normalizeDeliveryConsumptionActivityDiagnostic({ ...valid, smuggled: "message text" });
  assert.deepEqual(normalized, valid);
  assert.equal("smuggled" in (normalized as object), false);
});

test("malformed carriers are rejected rather than partially accepted", () => {
  const cases: Array<Record<string, unknown>> = [
    { ...valid, launchId: "" },
    { ...valid, episode: 0 },
    { ...valid, unconsumedDeliveries: -1 },
    { ...valid, unconsumedDeliveries: 2.5 },
    { ...valid, lastDeliveryPath: "carrier_pigeon" },
    { ...valid, lastConsumptionKind: "shout" },
    { ...valid, lastRuntimeResult: { kind: "completed", atMs: 1 } },
    { ...valid, lastRuntimeResult: { kind: "error", atMs: 1 } },
    { ...valid, lastDeliveryKey: "x".repeat(300) },
    { ...valid, processAlive: "yes" },
  ];
  for (const candidate of cases) {
    assert.equal(normalizeDeliveryConsumptionActivityDiagnostic(candidate), null, JSON.stringify(candidate).slice(0, 80));
  }
  assert.equal(normalizeDeliveryConsumptionActivityDiagnostic(null), null);
  assert.equal(normalizeDeliveryConsumptionActivityDiagnostic(undefined), null);
  assert.equal(normalizeDeliveryConsumptionActivityDiagnostic("carrier" as never), null);
});
