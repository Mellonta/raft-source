import "./helpers/domSetup";

import assert from "node:assert/strict";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import api from "../src/api/client";
import { projectRuntimeModelLabelPresentation, resetSharedRuntimeModelRequestsForTests, useRuntimeModels } from "../src/hooks/useRuntimeModels";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";

const originalGet = api.get.bind(api);

function makeServer(): Server {
  return {
    id: "server-model-source",
    name: "Model Source Server",
    avatarUrl: null,
    slug: "model-source-server",
    ownerId: "owner-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free",
    planDowngradedAt: null,
    role: "owner",
    createdAt: new Date(0).toISOString(),
  };
}

afterEach(() => {
  resetSharedRuntimeModelRequestsForTests();
  api.get = originalGet as typeof api.get;
  cleanup();
  useServerStore.getState().clearCurrent();
});

test("rescan recovers missing_config to live without a stale process cache", async () => {
  useServerStore.setState({ current: makeServer() });
  let calls = 0;
  api.get = (async () => {
    calls += 1;
    return calls === 1
      ? { data: { kind: "missing_config", recovery: "kimi_login" } }
      : { data: { kind: "live", value: { models: [{ id: "kimi-code/k2.7", label: "K2.7" }], default: "kimi-code/k2.7" } } };
  }) as typeof api.get;

  const { result, rerender } = renderHook(() => useRuntimeModels("machine-1", "kimi-sdk"));
  await waitFor(() => assert.equal(result.current.source.kind, "missing_config"));
  assert.ok(result.current.models.length > 0);
  assert.ok(result.current.models.every((m) => m.verified === "suggestion_only"));
  assert.equal(result.current.fromMachine, false);

  act(() => result.current.rescan());
  await waitFor(() => assert.equal(result.current.source.kind, "live"));
  assert.deepEqual(result.current.models, [
    { id: "kimi-code/k2.7", label: "K2.7" },
  ]);
  assert.equal(result.current.default, "kimi-code/k2.7");
  assert.equal(calls, 2);

  const stableResult = result.current;
  rerender();
  assert.equal(result.current, stableResult);
  assert.equal(result.current.source, stableResult.source);
  assert.equal(result.current.models, stableResult.models);
  assert.equal(result.current.suggestions, stableResult.suggestions);
  assert.equal(result.current.rescan, stableResult.rescan);
});

test("a new catalog identity is loading before effects and cannot expose the previous Computer's label", async () => {
  useServerStore.setState({ current: makeServer() });
  const requests: Array<{
    resolve: (value: { data: unknown }) => void;
  }> = [];
  api.get = (() => new Promise((resolve) => {
    requests.push({ resolve });
  })) as typeof api.get;
  let machineId = "machine-1";

  const { result, rerender } = renderHook(() => useRuntimeModels(machineId, "kimi-sdk"));
  assert.equal(result.current.source.kind, "loading");
  await waitFor(() => assert.equal(requests.length, 1));

  await act(async () => {
    requests[0].resolve({
      data: {
        kind: "live",
        value: { models: [{ id: "kimi-code/k3-256k", label: "Machine 1 K3" }] },
      },
    });
  });
  await waitFor(() => assert.equal(result.current.source.kind, "live"));
  assert.deepEqual(result.current.models, [
    { id: "kimi-code/k3-256k", label: "Machine 1 K3" },
  ]);

  machineId = "machine-2";
  rerender();

  assert.equal(result.current.source.kind, "loading");
  assert.deepEqual(result.current.models, []);
  assert.deepEqual(
    projectRuntimeModelLabelPresentation("kimi-sdk", "kimi-code/k3-256k", result.current),
    { kind: "pending" },
  );
  await waitFor(() => assert.equal(requests.length, 2));
});

test("passive readers share one probe and reuse a recent live catalog; a rescan and the default mode still ask the Computer", async () => {
  useServerStore.setState({ current: makeServer() });
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  api.get = (async () => {
    calls += 1;
    await gate;
    return { data: { kind: "live", value: { models: [{ id: "gpt-5.3-codex-high", label: "Codex 5.3 High" }], default: "gpt-5.3-codex-high" } } };
  }) as typeof api.get;

  // Two hover cards at once: one request.
  const first = renderHook(() => useRuntimeModels("machine-1", "cursor", { reuseRecentMs: 60_000 }));
  const second = renderHook(() => useRuntimeModels("machine-1", "cursor", { reuseRecentMs: 60_000 }));
  await waitFor(() => assert.equal(calls, 1));
  release();
  await waitFor(() => assert.equal(first.result.current.source.kind, "live"));
  await waitFor(() => assert.equal(second.result.current.source.kind, "live"));
  assert.equal(calls, 1, "overlapping passive readers share the request");

  // Another hover shortly after reuses the live catalog.
  const third = renderHook(() => useRuntimeModels("machine-1", "cursor", { reuseRecentMs: 60_000 }));
  await waitFor(() => assert.equal(third.result.current.source.kind, "live"));
  assert.equal(calls, 1, "a recent live catalog is reused");

  // An explicit rescan asks again.
  act(() => third.result.current.rescan());
  await waitFor(() => assert.equal(calls, 2));

  // Dialogs and panels (default mode) stay fresh on every mount.
  const panel = renderHook(() => useRuntimeModels("machine-1", "cursor"));
  await waitFor(() => assert.equal(panel.result.current.source.kind, "live"));
  assert.equal(calls, 3);
});

test("a shared live catalog expires after its window, and a failed probe is never reused", async () => {
  useServerStore.setState({ current: makeServer() });
  let calls = 0;
  let fail = true;
  api.get = (async () => {
    calls += 1;
    if (fail) throw new Error("probe timed out");
    return { data: { kind: "live", value: { models: [{ id: "auto", label: "Auto" }], default: "auto" } } };
  }) as typeof api.get;
  let now = 1_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    // A failure is not reused: the next reader asks again.
    const failed = renderHook(() => useRuntimeModels("machine-ttl", "cursor", { reuseRecentMs: 60_000 }));
    await waitFor(() => assert.equal(failed.result.current.source.kind, "error"));
    fail = false;
    const retried = renderHook(() => useRuntimeModels("machine-ttl", "cursor", { reuseRecentMs: 60_000 }));
    await waitFor(() => assert.equal(retried.result.current.source.kind, "live"));
    assert.equal(calls, 2, "an error result is never shared");

    // Inside the window: reused.
    now += 59_999;
    const inside = renderHook(() => useRuntimeModels("machine-ttl", "cursor", { reuseRecentMs: 60_000 }));
    await waitFor(() => assert.equal(inside.result.current.source.kind, "live"));
    assert.equal(calls, 2);

    // Past the window: asks again.
    now += 2;
    const expired = renderHook(() => useRuntimeModels("machine-ttl", "cursor", { reuseRecentMs: 60_000 }));
    await waitFor(() => assert.equal(calls, 3));
    await waitFor(() => assert.equal(expired.result.current.source.kind, "live"));
  } finally {
    Date.now = realNow;
  }
});
