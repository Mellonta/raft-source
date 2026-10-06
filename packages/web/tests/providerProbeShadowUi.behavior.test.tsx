import assert from "node:assert/strict";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ProviderProbeCreatedView, ProviderProbeReceiptList } from "@botiverse/raft-shared";

import api from "../src/api/client";
import { __testInternals } from "../src/components/settings/ProviderConnectionsSettings";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import { setServerFeatureFlagForTests } from "../src/store/serverFeatureFlags";
import { PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { TestIntlProvider } from "./helpers/intl";

const { VerifyProviderConnectionModal, VerifiedOnChip, ConnectionRow } = __testInternals;

afterEach(cleanup);

const CONNECTION_ID = "736b2dc6-dbe6-4733-b1ec-8b52daf25e27";
const MACHINE_ID = "machine-builtin-1";

function seedMachines() {
  useMachineStore.setState({
    machines: [
      {
        id: MACHINE_ID,
        name: "Studio Mac",
        description: null,
        status: "online",
        statusVersion: 1,
        apiKeyPrefix: null,
        runtimes: ["builtin"],
        runtimeVersions: { builtin: "pi-1" },
        hostname: null,
        os: null,
        daemonVersion: "daemon-1",
      },
    ],
  } as never);
}

function successView(reply: string | null): ProviderProbeCreatedView {
  return {
    probe: {
      probeId: "probe-1",
      probeRequestId: "req-1",
      connectionId: CONNECTION_ID,
      computerId: MACHINE_ID,
      runtime: "builtin",
      model: "deepseek/deepseek-v4-pro",
      probeKind: "canary",
      configVersion: 1,
      credentialVersion: 1,
      outcome: "success",
      category: null,
      latencyMs: 42,
      responseSha256: "a".repeat(64),
      responseBytes: 2,
      verifiedAt: "2026-09-15T00:00:00.000Z",
      closedAt: "2026-09-15T00:00:00.000Z",
      createdAt: "2026-09-15T00:00:00.000Z",
      expiresAt: "2026-09-15T00:01:00.000Z",
    },
    reply,
    replayed: false,
  };
}

test("verification modal never auto-closes and shows the bounded reply", async () => {
  seedMachines();
  const posts: unknown[] = [];
  vi.spyOn(api, "post").mockImplementation(async (url: string, body: unknown) => {
    posts.push({ url, body });
    return { data: successView("OK reply") };
  });
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: { receipts: [] } satisfies ProviderProbeReceiptList }));

  render(
    <TestIntlProvider>
      <VerifyProviderConnectionModal
        connection={{
          id: CONNECTION_ID,
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
          assignedAgentCount: 0,
          latestVerified: null,
          lastCheckedAt: null,
          lastErrorCategory: null,
          createdAt: "2026-08-14T00:00:00.000Z",
          updatedAt: "2026-08-14T00:00:00.000Z",
        }}
        onClose={() => assert.fail("the verification modal must never auto-close")}
      />
    </TestIntlProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Start verification" }));
  await screen.findByTestId("provider-connection-verify-success");
  // Still open after success: the user closes it explicitly.
  assert.ok(screen.getByTestId("provider-connection-verify-dialog"));
  const reply = screen.getByTestId("provider-connection-verify-reply");
  assert.equal(reply.textContent, "OK reply");
  assert.ok(screen.getByText(/Verified on Studio Mac/));
  assert.ok(screen.getByText(/42 ms/));

  fireEvent.click(screen.getByRole("button", { name: /Verify again/ }));
  await waitFor(() => assert.equal(posts.length, 2, "verify again is an explicit second provider call"));
});

test("verification failure shows the closed category and next step, modal stays open", async () => {
  seedMachines();
  vi.spyOn(api, "post").mockImplementation(async () => {
    const error = new Error("boom") as Error & { response?: { status: number } };
    error.response = { status: 502 };
    throw error;
  });
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: { receipts: [] } satisfies ProviderProbeReceiptList }));
  render(
    <TestIntlProvider>
      <VerifyProviderConnectionModal
        connection={{
          id: CONNECTION_ID,
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
          assignedAgentCount: 0,
          latestVerified: null,
          lastCheckedAt: null,
          lastErrorCategory: null,
          createdAt: "2026-08-14T00:00:00.000Z",
          updatedAt: "2026-08-14T00:00:00.000Z",
        }}
        onClose={() => assert.fail("the verification modal must never auto-close")}
      />
    </TestIntlProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Start verification" }));
  await screen.findByTestId("provider-connection-verify-failure");
  assert.ok(screen.getByText(/Address the category above/));
  assert.ok(screen.getByTestId("provider-connection-verify-dialog"));
});

test("verified-on chip renders from catalog data without extra requests", () => {
  render(
    <TestIntlProvider>
      <VerifiedOnChip
        latestVerified={{
          computerId: MACHINE_ID,
          computerName: "Studio Mac",
          runtime: "builtin",
          model: "deepseek/deepseek-v4-pro",
          verifiedAt: "2026-09-15T02:00:00.000Z",
        }}
      />
    </TestIntlProvider>,
  );
  assert.ok(screen.getByTestId("provider-connection-verified-on"));
  assert.ok(screen.getByText(/Verified on/));
  assert.ok(screen.getByText(/Studio Mac/));
});

test("enforcement hides the legacy server-side test button", () => {
  seedMachines();
  render(
    <TestIntlProvider>
      <ConnectionRow
        connection={{
          id: CONNECTION_ID,
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
          assignedAgentCount: 0,
          latestVerified: null,
          lastCheckedAt: null,
          lastErrorCategory: null,
          createdAt: "2026-08-14T00:00:00.000Z",
          updatedAt: "2026-08-14T00:00:00.000Z",
        }}
        providerOptions={[{ id: "deepseek", label: "DeepSeek", providerKind: "preset" }]}
        canManage
        legacyTestVisible={false}
        busy={false}
        onTest={() => assert.fail("legacy test must not be reachable under enforcement")}
        onVerify={() => undefined}
        onEdit={() => undefined}
        onToggle={() => undefined}
        onDelete={() => undefined}
      />
    </TestIntlProvider>,
  );
  assert.equal(screen.queryByRole("button", { name: "Test connection" }), null);
  const verifyBtn = screen.getByRole("button", { name: /Verify on Computer/ });
  assert.ok(verifyBtn);
  assert.ok(verifyBtn.className.includes("size-7"));
  assert.ok(verifyBtn.querySelector("svg.lucide-send"));
});

test("the verify modal submits the chosen model so receipt coordinates match the Agent", async () => {
  seedMachines();
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.spyOn(api, "post").mockImplementation(async (url: string, body: Record<string, unknown>) => {
    posts.push({ url, body });
    return { data: successView("OK") };
  });
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: { receipts: [] } }));
  render(
    <TestIntlProvider>
      <VerifyProviderConnectionModal
        connection={{
          id: CONNECTION_ID,
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
          assignedAgentCount: 0,
          latestVerified: null,
          lastCheckedAt: null,
          lastErrorCategory: null,
          createdAt: "2026-08-14T00:00:00.000Z",
          updatedAt: "2026-08-14T00:00:00.000Z",
        }}
        onClose={() => undefined}
      />
    </TestIntlProvider>,
  );
  const modelSelect = screen.getByRole("combobox", { name: "Model" });
  fireEvent.click(modelSelect);
  const customOption = await screen.findByRole("option", { name: "Custom" });
  fireEvent.pointerDown(customOption);
  fireEvent.click(customOption);
  const modelInput = await screen.findByPlaceholderText("Custom model ID");
  fireEvent.change(modelInput, { target: { value: "deepseek/deepseek-v4-pro" } });
  fireEvent.click(screen.getByRole("button", { name: "Start verification" }));
  await screen.findByTestId("provider-connection-verify-success");
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.body.model, "deepseek/deepseek-v4-pro");
  assert.equal(posts[0]!.body.runtime, "builtin");
});

test("verify modal allows selecting a different computer from the Computer Select", async () => {
  useMachineStore.setState({
    machines: [
      {
        id: "machine-1",
        name: "First Mac",
        description: null,
        status: "online",
        statusVersion: 1,
        apiKeyPrefix: null,
        runtimes: ["builtin"],
        runtimeVersions: { builtin: "pi-1" },
        hostname: null,
        os: null,
        daemonVersion: "daemon-1",
      },
      {
        id: "machine-2",
        name: "Second Mac",
        description: null,
        status: "online",
        statusVersion: 1,
        apiKeyPrefix: null,
        runtimes: ["builtin"],
        runtimeVersions: { builtin: "pi-1" },
        hostname: null,
        os: null,
        daemonVersion: "daemon-1",
      },
    ],
  } as never);

  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.spyOn(api, "post").mockImplementation(async (url: string, body: Record<string, unknown>) => {
    posts.push({ url, body });
    return { data: successView("OK") };
  });
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: { receipts: [] } }));

  render(
    <TestIntlProvider>
      <VerifyProviderConnectionModal
        connection={{
          id: CONNECTION_ID,
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
          assignedAgentCount: 0,
          latestVerified: null,
          lastCheckedAt: null,
          lastErrorCategory: null,
          createdAt: "2026-08-14T00:00:00.000Z",
          updatedAt: "2026-08-14T00:00:00.000Z",
        }}
        onClose={() => undefined}
      />
    </TestIntlProvider>,
  );

  const computerSelect = screen.getByRole("combobox", { name: "Computer" });
  assert.equal(computerSelect.tagName, "BUTTON", "Computer must use raft-ui Select trigger");
  fireEvent.click(computerSelect);
  const secondMacOption = await screen.findByRole("option", { name: "Second Mac" });
  fireEvent.pointerDown(secondMacOption);
  fireEvent.click(secondMacOption);

  fireEvent.click(screen.getByRole("button", { name: "Start verification" }));
  await screen.findByTestId("provider-connection-verify-success");
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.body.computerId, "machine-2");
});

test("the catalog read model renders verified chips with a single catalog request", async () => {
  seedMachines();
  let gets = 0;
  vi.spyOn(api, "get").mockImplementation(async (url: string) => {
    gets += 1;
    assert.equal(url, "/provider-connections");
    return {
      data: {
        connections: [
          {
            id: CONNECTION_ID,
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
            assignedAgentCount: 0,
            latestVerified: {
              computerId: MACHINE_ID,
              computerName: "Studio Mac",
              runtime: "builtin",
              model: "deepseek/deepseek-v4-pro",
              verifiedAt: "2026-09-15T02:00:00.000Z",
            },
            lastCheckedAt: null,
            lastErrorCategory: null,
            createdAt: "2026-08-14T00:00:00.000Z",
            updatedAt: "2026-08-14T00:00:00.000Z",
          },
          {
            id: "836b2dc6-dbe6-4733-b1ec-8b52daf25e28",
            name: "Second DeepSeek",
            providerId: "deepseek",
            authMethod: "api_key",
            endpointUrl: null,
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
          },
        ],
        providerOptions: [{ id: "deepseek", label: "DeepSeek", providerKind: "preset" }],
      },
    };
  });
  useServerStore.setState({
    current: { id: "server-shadow", name: "Shadow", slug: "shadow" },
  } as never);
  setServerFeatureFlagForTests("server-shadow", PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY, true);
  const { default: ProviderConnectionsSettings } = await import("../src/components/settings/ProviderConnectionsSettings");
  render(
    <MemoryRouter>
      <TestIntlProvider>
        <ProviderConnectionsSettings />
      </TestIntlProvider>
    </MemoryRouter>,
  );
  await screen.findByTestId("provider-connection-verified-on");
  assert.ok(screen.getByText(/Studio Mac/));
  assert.equal(gets, 1, "two connections must not fan out into per-row receipt reads");
});
