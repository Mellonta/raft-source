import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { ANTIPROTON_HOSTED_RUNTIME_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import type { AgentHostedRuntimeSummary } from "@botiverse/raft-shared";

import api from "../src/api/client";
import { describeHostedRuntime, HostedRuntimeStatus } from "../src/components/agent/HostedRuntimeStatus";
import { useAgentRuntimeProvider } from "../src/hooks/useAgentRuntimeProvider";
import { setServerFeatureFlagForTests } from "../src/store/serverFeatureFlags";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { useServerStore } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useServerStore.setState({ current: null, servers: [], members: [] } as never);
});

function summary(overrides: Partial<AgentHostedRuntimeSummary>): AgentHostedRuntimeSummary {
  return {
    provider: "antiproton",
    state: "active",
    providerAgentId: "raft_agent",
    syncPending: false,
    push: { registered: true, error: null },
    lastError: null,
    attemptCount: 0,
    nextAttemptAt: null,
    activatedAt: "2026-09-28T00:00:00.000Z",
    ...overrides,
  };
}

test("hosted runtime states map to labels, polling and retry availability", () => {
  assert.deepEqual(describeHostedRuntime(summary({ state: "provisioning", lastError: null })), {
    labelId: "agent.detail.hostedRuntime.state.provisioning", inProgress: true, canRetry: false,
  });
  assert.equal(describeHostedRuntime(summary({ state: "active" })).inProgress, false);
  assert.equal(describeHostedRuntime(summary({ state: "active", syncPending: true })).labelId, "agent.detail.hostedRuntime.state.syncing");
  assert.equal(describeHostedRuntime(summary({ state: "failed" })).canRetry, true);
  assert.equal(describeHostedRuntime(summary({ state: "deleting" })).canRetry, false);
  for (const id of Object.keys(en).filter((key) => key.startsWith("agent.detail.hostedRuntime.") || key.startsWith("agent.create.hostedRuntime."))) {
    assert.ok(zh[id], `${id} has a zh-cn translation`);
  }
});

test("a failed provisioning shows the provider error and retries", async () => {
  let retried = 0;
  render(
    <TestIntlProvider>
      <HostedRuntimeStatus
        summary={summary({
          state: "failed",
          providerAgentId: null,
          push: null,
          lastError: { code: "idempotency_conflict", message: "edits go through PATCH", httpStatus: 409, at: "2026-09-28T00:00:00.000Z" },
        })}
        onRetry={async () => { retried += 1; }}
      />
    </TestIntlProvider>,
  );
  assert.ok(screen.queryByText(en["agent.detail.hostedRuntime.state.failed"]) !== null);
  assert.match(screen.getByTestId("agent-hosted-runtime-error").textContent ?? "", /idempotency_conflict.*edits go through PATCH/);
  fireEvent.click(screen.getByRole("button", { name: en["agent.detail.hostedRuntime.retry"] }));
  await waitFor(() => assert.equal(retried, 1));
});

test("Run on antiproton is offered only when the server flag is on and the deployment reports it available", async () => {
  useServerStore.setState({ current: { id: "server-1", role: "admin" }, members: [] } as never);
  const get = vi.spyOn(api, "get").mockImplementation(async () => ({ data: { kind: "antiproton", available: true } }) as never);

  setServerFeatureFlagForTests("server-1", ANTIPROTON_HOSTED_RUNTIME_FEATURE_FLAG_KEY, false);
  const off = renderHook(() => useAgentRuntimeProvider("antiproton"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(off.result.current.available, false);
  assert.equal(get.mock.calls.length, 0, "no probe while the flag is off");
  off.unmount();

  setServerFeatureFlagForTests("server-1", ANTIPROTON_HOSTED_RUNTIME_FEATURE_FLAG_KEY, true);
  const on = renderHook(() => useAgentRuntimeProvider("antiproton"));
  await waitFor(() => assert.equal(on.result.current.available, true));
  assert.equal(get.mock.calls[0]?.[0], "/agent-runtime-providers/antiproton");
  on.unmount();

  get.mockImplementation(async () => ({ data: { kind: "antiproton", available: false } }) as never);
  const unconfigured = renderHook(() => useAgentRuntimeProvider("antiproton"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(unconfigured.result.current.available, false, "flag on but deployment not configured");
});
