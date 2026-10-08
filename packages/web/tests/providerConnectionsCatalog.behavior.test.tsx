import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import type { ProviderConnectionProviderOption, ProviderConnectionSummary } from "@botiverse/raft-shared";
import { PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";

import api from "../src/api/client";
import { __testInternals } from "../src/components/settings/ProviderConnectionsSettings";
import { useServerStore } from "../src/store/serverStore";
import { useProfileStore } from "../src/store/profileStore";
import { useMachineStore } from "../src/store/machineStore";
import { setServerFeatureFlagForTests } from "../src/store/serverFeatureFlags";
import { TestIntlProvider } from "./helpers/intl";

const { ConnectionRow, CreateProviderConnectionModal, EditProviderConnectionModal, ProviderConnectionTestModal } = __testInternals;

afterEach(cleanup);

test("provider verification reaches the API on HTTP without subtle or randomUUID", async () => {
  const connection = assignedConnection();
  const previousMachines = useMachineStore.getState().machines;
  useMachineStore.setState({ machines: [{
    id: "http-computer", name: "HTTP computer", status: "online", runtimes: ["builtin"],
    description: null, statusVersion: 1, apiKeyPrefix: null, hostname: null,
    os: "linux", daemonVersion: null, lastHeartbeat: null, createdAt: "2026-10-07T00:00:00Z",
  }] });
  const httpCrypto = Object.freeze({ getRandomValues: crypto.getRandomValues.bind(crypto) });
  vi.stubGlobal("crypto", httpCrypto);
  const post = vi.spyOn(api, "post").mockImplementation(async (url, body) => {
    assert.equal(url, `/provider-connections/${connection.id}/probes`);
    const { probeRequestId, requestDigest, ...payload } = body as Record<string, string>;
    assert.match(probeRequestId, /^[0-9a-f-]{36}$/);
    const canonical = Object.fromEntries(Object.entries({ ...payload, connectionId: connection.id, schema: "provider-probe-request.v1" }).sort(([a], [b]) => a.localeCompare(b)));
    assert.equal(requestDigest, createHash("sha256").update(JSON.stringify(canonical)).digest("hex"));
    return { data: { probe: { outcome: "success", latencyMs: 5, verifiedAt: "2026-10-07T00:00:00Z" }, reply: "probe reply" } };
  });
  try {
    const { VerifyProviderConnectionModal } = __testInternals;
    render(<TestIntlProvider><VerifyProviderConnectionModal connection={connection} onClose={() => undefined} /></TestIntlProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Start verification" }));
    await screen.findByTestId("provider-connection-verify-success");
    assert.equal(post.mock.calls.length, 1);
    assert.equal("subtle" in httpCrypto, false);
    assert.equal("randomUUID" in httpCrypto, false);
  } finally {
    vi.unstubAllGlobals();
    useMachineStore.setState({ machines: previousMachines });
  }
});

test("create-provider picker renders the complete server-projected builtin schema catalog", () => {
  const providerOptions: ProviderConnectionProviderOption[] = [
    { id: "deepseek", label: "DeepSeek", providerKind: "preset" },
    { id: "minimax", label: "MiniMax", providerKind: "preset" },
    { id: "openrouter", label: "OpenRouter", providerKind: "preset" },
    { id: "google", label: "Google", providerKind: "preset" },
    { id: "openai-compatible", label: "OpenAI Compatible", providerKind: "gateway" },
    { id: "anthropic-compatible", label: "Anthropic Compatible", providerKind: "gateway" },
  ];

  render(
    <TestIntlProvider>
      <CreateProviderConnectionModal
        providerOptions={providerOptions}
        onClose={() => undefined}
        onCreated={async () => undefined}
      />
    </TestIntlProvider>,
  );

  const trigger = screen.getByRole("combobox");
  fireEvent.click(trigger);

  for (const provider of providerOptions) {
    assert.ok(screen.getAllByText(provider.label).length > 0);
  }
});

test("connection test keeps manual model entry available when discovery fails and sends the selected request", async () => {
  const connection: ProviderConnectionSummary = {
    id: "736b2dc6-dbe6-4733-b1ec-8b52daf25e27",
    name: "OpenAI Compatible",
    providerId: "openai-compatible",
    authMethod: "api_key",
    endpointUrl: "https://gateway.example.test/v1",
    supportsImageInput: false,
    enabled: true,
    status: "unchecked",
    configVersion: 1,
    credentialVersion: 1,
    hasCredential: true,
    assignedAgentCount: 0,
    latestVerified: null,
    lastCheckedAt: null,
    lastErrorCategory: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
  let submitted: unknown;
  vi.spyOn(api, "get").mockImplementation(async (url: string) => {
    if (url.endsWith("/probes")) return { data: { receipts: [] } };
    assert.equal(url, `/provider-connections/${connection.id}/models`);
    throw new Error("catalog unavailable");
  });
  vi.spyOn(api, "post").mockImplementation(async (url: string, body?: unknown) => {
    assert.equal(url, `/provider-connections/${connection.id}/test`);
    submitted = body;
    return { data: { ...connection, status: "ready" } };
  });

  render(
    <TestIntlProvider>
      <ProviderConnectionTestModal
        connection={connection}
        onClose={() => undefined}
        onCompleted={async () => undefined}
      />
    </TestIntlProvider>,
  );

  await screen.findByText("Models could not be refreshed. You can still enter a model ID.");
  fireEvent.change(screen.getByLabelText("Test model"), { target: { value: "custom-model-v2" } });
  fireEvent.change(screen.getByLabelText("Test message"), { target: { value: "Return compatible-ok." } });
  fireEvent.click(screen.getByRole("button", { name: "Send test" }));

  await waitFor(() => {
    assert.deepEqual(submitted, { model: "custom-model-v2", message: "Return compatible-ok." });
  });
});

test("connection test renders standard model Select for preset models and allows custom model entry", async () => {
  const connection: ProviderConnectionSummary = {
    id: "736b2dc6-dbe6-4733-b1ec-8b52daf25e27",
    name: "Shared DeepSeek",
    providerId: "deepseek",
    authMethod: "api_key",
    endpointUrl: null,
    supportsImageInput: false,
    enabled: true,
    status: "unchecked",
    configVersion: 1,
    credentialVersion: 1,
    hasCredential: true,
    assignedAgentCount: 0,
    latestVerified: null,
    lastCheckedAt: null,
    lastErrorCategory: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
  let submitted: unknown;
  vi.spyOn(api, "get").mockImplementation(async (url: string) => {
    if (url.endsWith("/probes")) return { data: { receipts: [] } };
    assert.equal(url, `/provider-connections/${connection.id}/models`);
    return { data: { models: ["deepseek-v4-pro", "deepseek-custom-exp"] } };
  });
  vi.spyOn(api, "post").mockImplementation(async (url: string, body?: unknown) => {
    assert.equal(url, `/provider-connections/${connection.id}/test`);
    submitted = body;
    return { data: { ...connection, status: "ready" } };
  });

  render(
    <TestIntlProvider>
      <ProviderConnectionTestModal
        connection={connection}
        onClose={() => undefined}
        onCompleted={async () => undefined}
      />
    </TestIntlProvider>,
  );

  const modelTrigger = screen.getByRole("combobox", { name: "Test model" });
  assert.equal(modelTrigger.tagName, "BUTTON", "Test model must use raft-ui Select trigger");

  // Select custom
  fireEvent.click(modelTrigger);
  const customOption = await screen.findByRole("option", { name: "Custom" });
  fireEvent.pointerDown(customOption);
  fireEvent.click(customOption);

  const customInput = await screen.findByPlaceholderText("Custom model ID");
  fireEvent.change(customInput, { target: { value: "deepseek/my-exp-model" } });
  fireEvent.change(screen.getByLabelText("Test message"), { target: { value: "Hello" } });
  fireEvent.click(screen.getByRole("button", { name: "Send test" }));

  await waitFor(() => {
    assert.deepEqual(submitted, { model: "deepseek/my-exp-model", message: "Hello" });
  });
});

test("assigned connections explain why delete is disabled and how to unblock it", () => {
  const connection: ProviderConnectionSummary = {
    id: "736b2dc6-dbe6-4733-b1ec-8b52daf25e27",
    name: "Shared DeepSeek",
    providerId: "deepseek",
    authMethod: "api_key",
    endpointUrl: null,
    supportsImageInput: false,
    enabled: true,
    status: "ready",
    configVersion: 1,
    credentialVersion: 1,
    hasCredential: true,
    assignedAgentCount: 1,
    latestVerified: null,
    lastCheckedAt: null,
    lastErrorCategory: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };

  render(
    <TestIntlProvider>
      <ConnectionRow
        connection={connection}
        providerOptions={[{ id: "deepseek", label: "DeepSeek", providerKind: "preset" }]}
        canManage
        busy={false}
        onTest={() => undefined}
        onEdit={() => undefined}
        onToggle={() => undefined}
        onDelete={() => assert.fail("disabled delete must not run")}
      />
    </TestIntlProvider>,
  );

  const deleteButton = screen.getByRole("button", { name: "Delete connection" });
  assert.equal(deleteButton.getAttribute("aria-description"), "1 Agent uses this connection. Reassign it before deleting.");
  // title= migrated to the RUI Tooltip wrapper: no native title, trigger marker present.
  assert.equal(deleteButton.getAttribute("title"), null);
  assert.equal(deleteButton.hasAttribute("data-base-ui-tooltip-trigger"), true);
  assert.equal(deleteButton.getAttribute("aria-disabled"), "true");
  assert.equal(deleteButton.hasAttribute("disabled"), false);
  fireEvent.click(deleteButton);
});

function assignedConnection(overrides: Partial<ProviderConnectionSummary> = {}): ProviderConnectionSummary {
  return {
    id: "736b2dc6-dbe6-4733-b1ec-8b52daf25e27",
    name: "Shared DeepSeek",
    providerId: "deepseek",
    authMethod: "api_key",
    endpointUrl: null,
    supportsImageInput: false,
    enabled: true,
    status: "error",
    configVersion: 1,
    credentialVersion: 1,
    hasCredential: true,
    assignedAgentCount: 1,
    latestVerified: null,
    lastCheckedAt: null,
    lastErrorCategory: "connection_test_failed",
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

function renderConnectionRow(
  connection: ProviderConnectionSummary,
  overrides: Partial<ComponentProps<typeof ConnectionRow>> = {},
) {
  const row = (next: ProviderConnectionSummary, nextOverrides: Partial<ComponentProps<typeof ConnectionRow>>) => (
    <TestIntlProvider>
      <ConnectionRow
        connection={next}
        providerOptions={[{ id: "deepseek", label: "DeepSeek", providerKind: "preset" }]}
        canManage
        busy={false}
        onTest={() => undefined}
        onEdit={() => undefined}
        onToggle={() => undefined}
        onDelete={() => assert.fail("delete must stay blocked while an Agent is assigned")}
        {...nextOverrides}
      />
    </TestIntlProvider>
  );
  const view = render(row(connection, overrides));
  return {
    ...view,
    /** Re-render the same row with the catalog state the server would return next. */
    rerenderRow: (next: ProviderConnectionSummary, nextOverrides: Partial<ComponentProps<typeof ConnectionRow>> = {}) =>
      view.rerender(row(next, { ...overrides, ...nextOverrides })),
  };
}

test("the assigned-Agent count expands lazily, names the blocking Agent, and opens the existing Agent surface", async () => {
  const connection = assignedConnection({ assignedAgentCount: 2 });
  let reads = 0;
  let openedAgentId = "";
  const detached: string[] = [];
  vi.spyOn(api, "get").mockImplementation(async (url: string) => {
    if (url.endsWith("/probes")) return { data: { receipts: [] } };
    reads += 1;
    assert.equal(url, `/provider-connections/${connection.id}/agents`);
    return {
      data: {
        agents: [
          { id: "agent-active", name: "alice", displayName: "Alice", runtime: "claude", status: "active", computerName: "Alice MacBook", deleted: false },
          { id: "agent-retired", name: "retired", displayName: null, runtime: "builtin", status: "inactive", computerName: null, deleted: true },
        ],
      },
    };
  });
  vi.spyOn(api, "delete").mockImplementation(async (url: string) => {
    detached.push(url);
    return { status: 204, data: undefined };
  });
  const deletedRow = () => screen.getByTestId("provider-connection-assigned-agent-agent-retired");
  const confirmCalls: string[] = [];
  vi.spyOn(window, "confirm").mockImplementation((message: string) => {
    confirmCalls.push(message);
    return true;
  });

  const view = renderConnectionRow(connection, {
    onOpenAgent: (agentId) => { openedAgentId = agentId; },
    onDetachAgent: async (agentId) => {
      await api.delete(`/provider-connections/${connection.id}/agents/${agentId}`);
    },
  });

  assert.ok(screen.queryByTestId("provider-connection-assigned-agents") === null, "the panel stays closed until expanded");
  const toggle = screen.getByRole("button", { name: /2 Agents/ });
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  fireEvent.click(toggle);

  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  await screen.findByText("Alice");
  assert.equal(reads, 1);
  assert.ok(screen.getByText("@alice · Claude Code · Alice MacBook"));
  assert.ok(screen.getByText("Online"));
  // Canonical row contract: an active Agent is exactly one row button (no
  // nested interactive targets), and a deleted Agent's detach is its only
  // button, rendered as the row's action sibling.
  const activeRow = screen.getByTestId("provider-connection-assigned-agent-agent-active");
  const activeButtons = within(activeRow).getAllByRole("button");
  assert.equal(activeButtons.length, 1, "the active row is exactly one canonical row button");
  assert.equal(activeButtons[0]?.getAttribute("aria-label"), "Open Alice");
  assert.equal(activeButtons[0]?.tabIndex, 0, "the row button stays keyboard reachable");
  const deletedButtons = within(deletedRow()).getAllByRole("button");
  assert.equal(deletedButtons.length, 1, "detach is the deleted row's only button, never nested in a row button");
  assert.equal(deletedButtons[0]?.getAttribute("aria-label"), "Detach");
  assert.equal(deletedButtons[0]?.tabIndex, 0, "the detach control stays keyboard reachable");
  assert.ok(screen.getByTestId("provider-connection-assigned-agents").textContent?.includes(
    "To delete this connection, change or remove its provider for each Agent below.",
  ));

  fireEvent.click(screen.getByRole("button", { name: "Open Alice" }));
  assert.equal(openedAgentId, "agent-active");

  // A deleted Agent cannot be edited anywhere, so the panel must offer the only
  // remaining recovery path instead of a dead label.
  assert.ok(deletedRow().textContent?.includes("retired"));
  assert.ok(deletedRow().textContent?.includes("Deleted"));
  assert.ok(deletedRow().textContent?.includes("No Computer"));
  fireEvent.click(within(deletedRow()).getByRole("button", { name: "Detach" }));
  assert.deepEqual(detached, [`/provider-connections/${connection.id}/agents/agent-retired`]);
  assert.equal(confirmCalls.length, 1);
  await waitFor(() => assert.equal(reads, 2, "detach re-reads the open assignment list"));

  fireEvent.click(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  fireEvent.click(toggle);
  assert.equal(reads, 2, "collapsing and reopening reuses the bounded assignment list");

  // The reported failure was "cannot delete and cannot tell why". Once the last
  // assignment is gone the row must stop expanding and the delete must arm.
  let deleted = false;
  view.rerenderRow(
    assignedConnection({ assignedAgentCount: 0 }),
    { onDelete: () => { deleted = true; } },
  );
  assert.ok(screen.queryByTestId("provider-connection-assigned-agents") === null, "the panel closes once nothing is assigned");
  assert.ok(screen.queryByRole("button", { name: /Agents/ }) === null, "the count stops being expandable");
  const deleteButton = screen.getByRole("button", { name: "Delete connection" });
  assert.equal(deleteButton.getAttribute("aria-disabled"), null);
  fireEvent.click(deleteButton);
  assert.equal(deleted, true);
});

test("an unassigned connection is not expandable and never reads the assignment list", async () => {
  let reads = 0;
  vi.spyOn(api, "get").mockImplementation(async (url: string) => {
    if (url.endsWith("/probes")) return { data: { receipts: [] } };
    reads += 1;
    return { data: { agents: [] } };
  });

  renderConnectionRow(assignedConnection({ assignedAgentCount: 0, status: "ready", lastErrorCategory: null }));

  assert.ok(screen.queryByRole("button", { name: /Agents/ }) === null, "an unassigned connection is not expandable");
  assert.ok(screen.getByText(/0 Agents/));
  assert.ok(screen.queryByTestId("provider-connection-assigned-agents") === null);
  assert.equal(reads, 0);
});

test("a failed assignment read explains itself and offers a retry", async () => {
  const connection = assignedConnection();
  let reads = 0;
  vi.spyOn(api, "get").mockImplementation(async (url: string) => {
    if (url.endsWith("/probes")) return { data: { receipts: [] } };
    reads += 1;
    if (reads === 1) throw new Error("assignment read failed");
    return {
      data: {
        agents: [
          { id: "agent-active", name: "alice", displayName: "Alice", runtime: "claude", status: "stopped", computerName: null, deleted: false },
        ],
      },
    };
  });

  renderConnectionRow(connection, { onOpenAgent: () => undefined, onDetachAgent: async () => undefined });

  fireEvent.click(screen.getByRole("button", { name: /1 Agent/ }));
  await screen.findByText("Assigned Agents could not be loaded.");
  assert.ok(screen.queryByText("Alice") === null, "a failed read must not invent Agents");

  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Alice");
  assert.equal(reads, 2);
  assert.ok(screen.getByText("@alice · Claude Code · No Computer"));
  assert.ok(screen.getByText("Stopped"));
});

test("connection row displays enabled checkmark regardless of test status unchecked or error", () => {
  const providerOptions: ProviderConnectionProviderOption[] = [
    { id: "deepseek", label: "DeepSeek", providerKind: "preset" },
  ];
  const enabledUnchecked: ProviderConnectionSummary = {
    id: "conn-1",
    name: "Enabled Unchecked",
    providerId: "deepseek",
    authMethod: "api_key",
    endpointUrl: null,
    supportsImageInput: false,
    enabled: true,
    status: "unchecked",
    configVersion: 1,
    credentialVersion: 1,
    hasCredential: true,
    assignedAgentCount: 0,
    latestVerified: null,
    lastCheckedAt: null,
    lastErrorCategory: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
  const { unmount } = render(
    <TestIntlProvider>
      <ConnectionRow
        connection={enabledUnchecked}
        providerOptions={providerOptions}
        canManage
        legacyTestVisible={false}
        busy={false}
        onTest={() => undefined}
        onEdit={() => undefined}
        onToggle={() => undefined}
        onDelete={() => undefined}
      />
    </TestIntlProvider>,
  );
  const rowEl = screen.getByTestId("provider-connection-conn-1");
  const indicator = rowEl.querySelector("span");
  assert.ok(indicator?.className.includes("bg-green-100"), "enabled connection must have green indicator");
  assert.ok(indicator?.querySelector("svg.lucide-circle-check"), "enabled connection must have check icon");
  unmount();

  const disabledReady: ProviderConnectionSummary = {
    ...enabledUnchecked,
    id: "conn-2",
    name: "Disabled Ready",
    enabled: false,
    status: "ready",
  };
  render(
    <TestIntlProvider>
      <ConnectionRow
        connection={disabledReady}
        providerOptions={providerOptions}
        canManage
        legacyTestVisible={false}
        busy={false}
        onTest={() => undefined}
        onEdit={() => undefined}
        onToggle={() => undefined}
        onDelete={() => undefined}
      />
    </TestIntlProvider>,
  );
  const disabledRowEl = screen.getByTestId("provider-connection-conn-2");
  const disabledIndicator = disabledRowEl.querySelector("span");
  assert.ok(disabledIndicator?.className.includes("bg-black/5"), "disabled connection must have dark/gray indicator");
  assert.ok(disabledIndicator?.querySelector("svg.lucide-circle-x"), "disabled connection must have X icon");
});

test("unified edit modal allows updating name, gateway endpoint, image support, and optional api key", async () => {
  const providerOptions: ProviderConnectionProviderOption[] = [
    { id: "openai-compatible", label: "OpenAI Compatible", providerKind: "gateway" },
  ];
  const connection: ProviderConnectionSummary = {
    id: "conn-gateway",
    name: "Original Gateway",
    providerId: "openai-compatible",
    authMethod: "api_key",
    endpointUrl: "https://gateway.example.test/v1",
    supportsImageInput: false,
    enabled: true,
    status: "ready",
    configVersion: 1,
    credentialVersion: 1,
    hasCredential: true,
    assignedAgentCount: 0,
    latestVerified: null,
    lastCheckedAt: null,
    lastErrorCategory: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };

  let submittedPatch: unknown;
  vi.spyOn(api, "patch").mockImplementation(async (url: string, body?: unknown) => {
    assert.equal(url, `/provider-connections/${connection.id}`);
    submittedPatch = body;
    return { data: { ...connection, ...((body as Record<string, unknown>) ?? {}) } };
  });

  const { unmount } = render(
    <TestIntlProvider>
      <EditProviderConnectionModal
        connection={connection}
        providerOptions={providerOptions}
        onClose={() => undefined}
        onCompleted={async () => undefined}
      />
    </TestIntlProvider>,
  );

  const nameInput = screen.getByLabelText("Connection name");
  const endpointInput = screen.getByLabelText("Base URL");
  const imageCheckbox = screen.getByRole("checkbox", { name: "This gateway supports image input" });
  const apiKeyInput = screen.getByLabelText("API key");

  assert.equal((nameInput as HTMLInputElement).value, "Original Gateway");
  assert.equal((endpointInput as HTMLInputElement).value, "https://gateway.example.test/v1");
  assert.equal(imageCheckbox.getAttribute("aria-checked"), "false");
  assert.equal((apiKeyInput as HTMLInputElement).value, "");

  // Update without API key: should omit apiKey from payload
  fireEvent.change(nameInput, { target: { value: "Updated Gateway" } });
  fireEvent.change(endpointInput, { target: { value: "https://new-gateway.test/v1" } });
  fireEvent.click(imageCheckbox);

  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => {
    assert.deepEqual(submittedPatch, {
      name: "Updated Gateway",
      endpointUrl: "https://new-gateway.test/v1",
      supportsImageInput: true,
    });
  });

  unmount();

  // Test with API key filled: should include apiKey in payload
  submittedPatch = null;
  render(
    <TestIntlProvider>
      <EditProviderConnectionModal
        connection={connection}
        providerOptions={providerOptions}
        onClose={() => undefined}
        onCompleted={async () => undefined}
      />
    </TestIntlProvider>,
  );

  const keyInput = screen.getByLabelText("API key");
  fireEvent.change(keyInput, { target: { value: "new-secret-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => {
    assert.deepEqual(submittedPatch, {
      name: "Original Gateway",
      endpointUrl: "https://gateway.example.test/v1",
      supportsImageInput: false,
      apiKey: "new-secret-key",
    });
  });
});

test("ProviderConnectionsSettings opens assigned agent in the right-side profile panel instead of full-page navigation", async () => {
  const connection: ProviderConnectionSummary = {
    id: "conn-agents",
    serverId: "server-test",
    name: "Test Connection",
    providerId: "deepseek",
    status: "ready",
    enabled: true,
    endpointUrl: null,
    supportsImageInput: false,
    configVersion: 1,
    credentialVersion: 1,
    hasCredential: true,
    assignedAgentCount: 1,
    latestVerified: null,
    lastCheckedAt: null,
    lastErrorCategory: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };

  vi.spyOn(api, "get").mockImplementation(async (url: string) => {
    if (url === "/provider-connections") {
      return {
        status: 200,
        data: {
          connections: [connection],
          providerOptions: [{ id: "deepseek", label: "DeepSeek", providerKind: "preset" }],
        },
      };
    }
    if (url === "/provider-connections/conn-agents/agents") {
      return {
        status: 200,
        data: {
          agents: [
            {
              id: "agent-active",
              name: "Alice",
              displayName: "Alice",
              role: "Developer",
              runtime: "codex",
              model: "deepseek/deepseek-chat",
              status: "active",
              deletedAt: null,
              machineName: "MacBook",
            },
          ],
        },
      };
    }
    throw new Error(`unexpected GET: ${url}`);
  });

  useServerStore.setState({
    current: { id: "server-test", name: "Test Server", slug: "test" },
  } as never);
  setServerFeatureFlagForTests("server-test", PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY, true);

  useProfileStore.setState({ profileId: null, profileType: null });

  const { default: ProviderConnectionsSettings } = await import("../src/components/settings/ProviderConnectionsSettings");
  render(
    <MemoryRouter>
      <TestIntlProvider>
        <ProviderConnectionsSettings />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  await screen.findByText("Test Connection");
  const expandButton = screen.getByRole("button", { name: /1 Agent/ });
  fireEvent.click(expandButton);

  await screen.findByText("Alice");
  fireEvent.click(screen.getByRole("button", { name: "Open Alice" }));

  assert.equal(useProfileStore.getState().profileType, "agent");
  assert.equal(useProfileStore.getState().profileId, "agent-active");
});
