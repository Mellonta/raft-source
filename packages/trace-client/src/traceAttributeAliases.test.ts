import assert from "node:assert/strict";
import { LEGACY_TO_CANONICAL_TRACE_ATTRS, withCanonicalTraceAttributes } from "./traceAttributeAliases";

test("withCanonicalTraceAttributes adds the canonical key next to a lone legacy spelling", () => {
  const attrs = { agentId: "agent-1", launchId: "launch-1", outcome: "queued" };

  const out = withCanonicalTraceAttributes(attrs);

  assert.deepEqual(out, {
    agentId: "agent-1",
    launchId: "launch-1",
    outcome: "queued",
    agent_id: "agent-1",
    launch_id: "launch-1",
  });
  assert.deepEqual(attrs, { agentId: "agent-1", launchId: "launch-1", outcome: "queued" }, "input is not mutated");
});

test("withCanonicalTraceAttributes never overrides an existing canonical value", () => {
  const attrs = { agentId: "legacy", agent_id: "canonical" };

  assert.equal(withCanonicalTraceAttributes(attrs), attrs, "same reference when nothing is added");
  assert.equal(attrs.agent_id, "canonical");
});

test("withCanonicalTraceAttributes ignores undefined legacy values and unrelated keys", () => {
  const attrs = { agentId: undefined, machineId: null, status: "ok" };

  const out = withCanonicalTraceAttributes(attrs);

  assert.equal(Object.hasOwn(out, "agent_id"), false, "undefined is not promoted");
  assert.deepEqual(out, { ...attrs, machine_id: null }, "null is a real value and is promoted");
  assert.equal(out.status, "ok");
});

test("every legacy key maps to a distinct snake_case canonical key", () => {
  const canonical = Object.values(LEGACY_TO_CANONICAL_TRACE_ATTRS);
  assert.equal(new Set(canonical).size, canonical.length);
  for (const key of canonical) assert.match(key, /^[a-z]+(_[a-z]+)*$/);
});

test("withCanonicalTraceAttributes with an allowlist only canonicalizes the listed legacy keys", () => {
  const attrs = { agentId: "agent-1", launchId: "launch-1" };

  const out = withCanonicalTraceAttributes(attrs, { keys: ["agentId"] });

  assert.deepEqual(out, { agentId: "agent-1", launchId: "launch-1", agent_id: "agent-1" });
  assert.equal(Object.hasOwn(out, "launch_id"), false, "span-only fields are not pushed onto events");
});
