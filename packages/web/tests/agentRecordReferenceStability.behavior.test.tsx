import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act } from "react";
import { cleanup, render } from "@testing-library/react";
import { createRenderCounter } from "./helpers/renderCount";
import { reconcileAgentsList, useAgentStore } from "../src/store/agentStore";
import type { Agent } from "../src/store/agentStore";

/**
 * task #633 — a server-added field the web does not model must not decide
 * whether an agent row counts as changed.
 *
 * Why this is worth a test at all: the regression it guards is INVISIBLE. It
 * raises no error and turns nothing red; the only symptom is that
 * `reconcileAgentsList` stops reusing references, which churns every
 * `agents`-derived selector and re-renders the message list (#proj-o11y /
 * #wg-frontend-perf). Without this file, the next server field that lands
 * silently costs the same re-render storm the reconcile exists to prevent.
 *
 * Complements `agentsListReferenceStability.test.ts`, which covers the reuse /
 * swap / add / nested-field behaviour for fields the web DOES model. This file
 * covers only the dimension that one cannot see: keys the web does not model.
 * It is a `.test.tsx` because the render-count evidence needs the DOM half.
 *
 * Both halves are asserted on purpose. Ignoring unknown keys is only correct if
 * known fields are still compared — an implementation that ignored everything
 * would pass the first half and turn a performance fix into "the UI does not
 * update", which is far worse and much harder to notice.
 */

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    name: "alpha",
    displayName: "Alpha",
    avatarUrl: null,
    description: null,
    status: "active",
    model: "m",
    runtime: "claude",
    serverRole: null,
    reasoningEffort: null,
    executionMode: "byoc",
    envVars: null,
    machineId: "machine-1",
    creatorType: null,
    creatorId: null,
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  } as Agent;
}

/** An agent row carrying a field this build does not model, e.g. task #336's
 *  `activitySource`. Cast because not modelling it is the whole point. */
function withServerKey(agent: Agent, value: string): Agent {
  return { ...agent, activitySource: value } as unknown as Agent;
}

afterEach(() => {
  cleanup();
  useAgentStore.setState({ agents: [] } as never);
});

test("an unknown server key changing value does not make the row count as changed", () => {
  const prev = [withServerKey(makeAgent(), "snapshot")];
  const next = [withServerKey(makeAgent(), "derived")];

  const reconciled = reconcileAgentsList(prev, next);

  assert.equal(reconciled, prev, "the list array itself must be reused");
  assert.equal(reconciled[0], prev[0], "the row reference must be reused");
});

test("an unknown server key appearing for the first time does not make the row count as changed", () => {
  // The rollout frame: the cached row predates the new field, the freshly
  // fetched one carries it. The old comparator failed this on key COUNT before
  // it ever looked at a value.
  const prev = [makeAgent()];
  const next = [withServerKey(makeAgent(), "snapshot")];

  assert.equal(reconcileAgentsList(prev, next), prev);
});

test("POSITIVE CONTROL: a known field changing still counts as changed", () => {
  const prev = [makeAgent({ displayName: "Alpha" })];
  const next = [makeAgent({ displayName: "Alpha renamed" })];

  const reconciled = reconcileAgentsList(prev, next);

  assert.notEqual(reconciled, prev, "a real identity change must produce a new list");
  assert.notEqual(reconciled[0], prev[0], "a real identity change must produce a new row");
  assert.equal(reconciled[0].displayName, "Alpha renamed");
});

test("POSITIVE CONTROL: a known field changing while an unknown key is present still counts as changed", () => {
  // Guards the over-correction: ignoring unknown keys must not leak into
  // ignoring the keys beside them.
  const prev = [withServerKey(makeAgent({ status: "active" }), "snapshot")];
  const next = [withServerKey(makeAgent({ status: "stopped" }), "snapshot")];

  assert.notEqual(reconcileAgentsList(prev, next), prev);
});

test("an optional known field absent vs explicitly undefined counts as unchanged", () => {
  // The one behaviour this change alters, ruled acceptable by Stone in the
  // PR #8125 review: the old comparator compared `Object.keys(...)` COUNTS
  // first, so `{}` vs `{ sessionId: undefined }` read as a change. The two
  // states mean the same thing, and calling them different is one of the ways
  // this comparator manufactured re-renders. Pinned here so a later reader does
  // not "fix" it back — his ruling, not an accident of the implementation.
  const withoutKey = makeAgent();
  assert.ok(!("sessionId" in withoutKey), "fixture really omits the optional key");
  const withExplicitUndefined: Agent = { ...withoutKey, sessionId: undefined };
  assert.ok("sessionId" in withExplicitUndefined, "the other side really carries the key");

  const prev = [withoutKey];
  const reconciled = reconcileAgentsList(prev, [withExplicitUndefined]);

  assert.equal(reconciled, prev, "the list array must be reused");
  assert.equal(reconciled[0], prev[0], "the row reference must be reused");
});

test("POSITIVE CONTROL: an optional known field going undefined → a value still counts as changed", () => {
  // The boundary above must not spill into ignoring the field. Stone's ruling
  // covers absent-vs-undefined only; null and real values stay significant.
  const prev = [makeAgent()];
  const next = [makeAgent({ sessionId: "session-1" })];

  assert.notEqual(reconcileAgentsList(prev, next), prev);
});

test("POSITIVE CONTROL: an optional known field going value → null still counts as changed", () => {
  const prev = [makeAgent({ sessionId: "session-1" })];
  const next = [makeAgent({ sessionId: null })];

  assert.notEqual(reconcileAgentsList(prev, next), prev);
});

test("POSITIVE CONTROL: a known nested field changing still counts as changed", () => {
  const prev = [makeAgent({ envVars: { A: "1" } })];
  const next = [makeAgent({ envVars: { A: "2" } })];

  assert.notEqual(reconcileAgentsList(prev, next), prev);
});

test("an unknown key flipping does not re-render an agents subscriber; a known field does", () => {
  // The user-visible consequence, measured rather than argued. A subscriber on
  // `agents` is what ChatPanel's mentionMap / agentById are, and their identity
  // churn is what re-renders the message list.
  function AgentsSubscriber() {
    const agents = useAgentStore((state) => state.agents);
    return <span>{agents.length}</span>;
  }

  useAgentStore.setState({ agents: [withServerKey(makeAgent(), "snapshot")] } as never);
  const rc = createRenderCounter();
  render(<rc.Count id="sub"><AgentsSubscriber /></rc.Count>);
  const mounted = rc.get("sub");
  assert.ok(mounted >= 1, "subscriber mounted");

  act(() => {
    useAgentStore.setState((state) => ({
      agents: reconcileAgentsList(state.agents, [withServerKey(makeAgent(), "derived")]),
    }));
  });
  assert.equal(
    rc.get("sub"),
    mounted,
    "a server field the web does not model must not re-render agents subscribers",
  );

  act(() => {
    useAgentStore.setState((state) => ({
      agents: reconcileAgentsList(state.agents, [withServerKey(makeAgent({ displayName: "Renamed" }), "derived")]),
    }));
  });
  assert.ok(
    rc.get("sub") > mounted,
    "a real identity change must still reach agents subscribers",
  );
});
