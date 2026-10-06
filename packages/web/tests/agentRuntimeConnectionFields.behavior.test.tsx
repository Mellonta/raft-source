import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import "./helpers/domSetup";
import { TestIntlProvider } from "./helpers/intl";
import AgentDetailPanel from "../src/components/agent/AgentDetailPanel";
import api from "../src/api/client";
import {
  KIMI_SDK_FORM_DEFINITION_REF,
  PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
} from "@botiverse/raft-shared";
import type {
  ResolvedAgentCreateFormDefinition,
  RuntimeFormDefinitionRef,
} from "@botiverse/raft-shared";
import { releasedRuntimeFormDefinition, toRuntimeFormV2 } from "@botiverse/raft-runtime-form";
import {
  resetServerFeatureFlagsForTests,
  RUNTIME_FORM_V2_WEB_FLAG_KEY,
  setServerFeatureFlagForTests,
} from "../src/store/serverFeatureFlags";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";

// task #41 behavior teeth. A saved Provider now lives in the ordinary Provider
// selector and reuses the ordinary provider schema. Connection-owned values stay
// visible in place but inert; the browser never receives the credential.
const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);
const originalPatch = api.patch.bind(api);
const noop = () => undefined;
const kimiRef: RuntimeFormDefinitionRef = KIMI_SDK_FORM_DEFINITION_REF;

function kimiDefinitionFixture(): ResolvedAgentCreateFormDefinition {
  return {
    ...kimiRef,
    dataSchema: {
      type: "object",
      additionalProperties: false,
      required: ["model"],
      properties: {
        model: { type: "string", title: "Model", minLength: 1 },
        reasoningEffort: { type: "string", title: "Thinking effort", minLength: 1 },
        envVars: { type: "object", title: "Environment Variables", additionalProperties: { type: "string" } },
      },
    },
    uiSchema: {
      order: ["model", "reasoningEffort", "envVars"],
      layout: { advanced: ["/envVars"] },
      visibility: [],
      localization: {
        model: { label: "Served Kimi model" },
        reasoningEffort: { label: "Served thinking effort" },
        envVars: { label: "Served environment" },
      },
    },
    capabilities: {
      providerKinds: [],
      writeOnlyPointers: [],
      forbiddenPointers: ["/hostUserState"],
    },
    optionSources: {
      model: {
        ...kimiRef,
        sourceId: "model",
        kind: "select",
        pointer: "/model",
        options: [
          {
            value: "kimi-code/k3",
            label: "Kimi K3",
            supportedReasoningEfforts: ["balanced-plus", "ultra"],
            defaultReasoningEffort: "balanced-plus",
          },
          { value: "kimi-code/k2", label: "Kimi K2" },
        ],
        defaultValue: "kimi-code/k3",
      },
    },
  };
}

function kimiDefinitionResponse() {
  const definition = kimiDefinitionFixture();
  return {
    ...definition,
    optionSources: {
      model: {
        ...kimiRef,
        sourceId: "model",
        kind: "select" as const,
        pointer: "/model",
      },
    },
  };
}

function connectedAgent(useConnection: boolean) {
  return {
    id: "agent-1",
    name: "witty",
    runtime: "builtin",
    status: "active",
    machineId: "machine-1",
    runtimeConfig: {
      version: 1,
      runtime: "builtin",
      provider: useConnection
        ? { kind: "connection", connectionId: CONNECTION_ID }
        : { kind: "preset", providerId: "deepseek", apiKey: "" },
      model: { kind: "preset", id: "deepseek-v4-pro" },
      mode: { kind: "default" },
      reasoningEffort: null,
    },
  };
}

function seed(
  agent: Record<string, unknown>,
  machineName = "m",
  connectionOverrides: Record<string, unknown> = {},
) {
  useAuthStore.setState({ user: { id: "user-1", name: "Owner" } } as never);
  useServerStore.setState({
    current: { id: "server-1", slug: "s", name: "S", role: "owner" },
    members: [],
  } as never);
  useMachineStore.setState({ machines: [{ id: "machine-1", name: machineName, status: "online" }] } as never);
  useChannelStore.setState({ openDM: noop } as never);
  useAgentStore.setState({ agents: [agent], activityLogs: {}, agentActivities: {} } as never);

  // `useProviderConnections` reads the feature flag from the serverFeatureFlags
  // STORE, not from the evaluate endpoint — stubbing `api.post` alone leaves the
  // catalog disabled, and the provider-connection select then never renders at
  // all. That is why it sat outside every assertion here until now.
  setServerFeatureFlagForTests("server-1", PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY, true);

  api.post = (async (url: string) =>
    url === "/feature-flags/evaluate"
      ? { data: { flags: { provider_connections_v0: { enabled: true } } } }
      : { data: {} }) as never;
  api.get = (async (url: string) =>
    url === "/provider-connections"
      ? {
          data: {
            connections: [{
              id: CONNECTION_ID, name: "ds official api", providerId: "deepseek",
              authMethod: "api_key", endpointUrl: null, supportsImageInput: false,
              enabled: true, status: "ready", configVersion: 1, credentialVersion: 1,
              hasCredential: true, assignedAgentCount: 1, latestVerified: null,
              lastCheckedAt: null, lastErrorCategory: null,
              createdAt: "2026-08-03T08:00:00.000Z", updatedAt: "2026-08-03T08:00:00.000Z",
              ...connectionOverrides,
            }],
            providerOptions: [{ providerId: "deepseek", label: "DeepSeek", authMethods: ["api_key"] }],
          },
        }
      : { data: {} }) as never;
}

async function openRuntimeEditor(
  useConnection: boolean,
  loadLocalPlugins?: boolean,
  connectionOverrides?: Record<string, unknown>,
) {
  const agent = connectedAgent(useConnection);
  if (loadLocalPlugins !== undefined) Object.assign(agent.runtimeConfig, { loadLocalPlugins });
  seed(agent, "m", connectionOverrides);
  render(
    <MemoryRouter>
      <TestIntlProvider locale="en">
        <AgentDetailPanel agent={agent as never} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
  const opener = await waitFor(() => {
    const el = document.querySelector('[aria-label="Edit runtime config"]');
    assert.ok(el, "runtime-config edit control not found");
    return el as HTMLElement;
  });
  fireEvent.click(opener);
  await waitFor(() => assert.ok(document.querySelector('[class*="card-brutal"]'), "dialog did not open"));
}

afterEach(() => {
  cleanup();
  resetServerFeatureFlagsForTests();
  api.get = originalGet;
  api.post = originalPost;
  api.patch = originalPatch;
  useAgentStore.setState({ agents: [], activityLogs: {}, agentActivities: {} } as never);
  useServerStore.setState({ current: null, members: [] } as never);
  useAuthStore.setState({ user: null } as never);
});

test("connection mode keeps the provider schema and shows a disabled credential placeholder", async () => {
  await openRuntimeEditor(true);
  const apiKey = await screen.findByTestId("runtime-built-in-api-key");
  assert.equal(apiKey.hasAttribute("disabled"), true);
  assert.equal(apiKey.getAttribute("placeholder"), "Provided by “ds official api”");
  assert.equal((apiKey as HTMLInputElement).value, "");
  assert.equal(screen.queryAllByText(/needs an API key/i).length, 0,
    "the required-key error must not render while a connection is selected");

  const editButton = screen.getByRole("button", { name: "Edit saved provider" });
  fireEvent.click(editButton);
  const editDialog = await screen.findByTestId("provider-connection-edit-dialog");
  const secretInput = editDialog.querySelector<HTMLInputElement>('input[type="password"]');
  assert.ok(secretInput, "the shared connection editor must expose the optional replacement-key input");
  assert.equal(secretInput.value, "", "the existing provider credential must never be returned to the browser");
  assert.equal(
    editDialog.querySelector<HTMLInputElement>('input[value="ds official api"]')?.value,
    "ds official api",
  );
});

test("agent-local mode still renders the API key field", async () => {
  await openRuntimeEditor(false);
  await waitFor(() => {
    assert.ok(screen.queryAllByPlaceholderText("sk-...").length > 0,
      "without a connection the agent-local key field must still render");
  });
  assert.ok(
    screen.queryByRole("button", { name: "Edit saved provider" }) === null,
    "direct setup must not show the saved-provider edit action",
  );
});

test("switching from a saved provider to direct setup requires a fresh local key", async () => {
  await openRuntimeEditor(true);
  const provider = await screen.findByTestId("runtime-built-in-provider-select");
  fireEvent.click(provider);
  const direct = await screen.findByRole("option", { name: "DeepSeek", exact: true });
  fireEvent.pointerDown(direct);
  fireEvent.click(direct);

  const apiKey = await screen.findByTestId("runtime-built-in-api-key");
  assert.equal(apiKey.hasAttribute("disabled"), false);
  assert.equal(apiKey.getAttribute("placeholder"), "sk-...");
  assert.equal((apiKey as HTMLInputElement).value, "");
});

test("an unavailable current saved provider stays visible and blocks a silent rewrite", async () => {
  await openRuntimeEditor(true, undefined, { enabled: false });
  assert.ok(await screen.findByText("This saved provider is unavailable. Select another provider."));
  const provider = screen.getByTestId("runtime-built-in-provider-select");
  assert.match(provider.textContent ?? "", /DeepSeek · ds official api/);
  assert.equal(screen.getByRole("button", { name: "Save runtime config" }).hasAttribute("disabled"), true);
});

test("Kimi edit preserves an incompatible value as read-only and cannot write effort without model metadata", async () => {
  const agent = {
    id: "agent-1",
    name: "kimi",
    runtime: "kimi-sdk",
    status: "inactive",
    machineId: "machine-1",
    reasoningEffort: null,
    runtimeConfig: {
      version: 1,
      runtime: "kimi-sdk",
      provider: { kind: "default" },
      model: { kind: "preset", id: "kimi-code/k3" },
      mode: { kind: "default" },
      reasoningEffort: "legacy-effort",
      envVars: null,
    },
  };
  seed(agent);
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => ({ ...machine, runtimes: ["kimi-sdk"] })),
  }));
  const patches: Array<Record<string, unknown>> = [];
  api.get = (async (url: string) => {
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } } as never;
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    if (url === "/agents/agent-1/runtime-options") {
      return {
        data: {
          context: "existing_agent",
          machineId: "machine-1",
          options: [{
            runtimeId: "kimi-sdk",
            capabilityStatus: "available",
            admissionStatus: "available_for_new",
            admissionReason: null,
            current: true,
            availableForNew: true,
            manageableForCurrentAgent: true,
            canSelectInThisContext: true,
            formDefinitionRef: kimiRef,
          }],
        },
      } as never;
    }
    if (url.includes("/runtime-form-definitions/kimi-sdk/option-sources/model?schemaVersion=")) {
      return { data: kimiDefinitionFixture().optionSources.model } as never;
    }
    if (url.includes("/runtime-form-definitions/kimi-sdk?schemaVersion=")) {
      return { data: kimiDefinitionResponse() } as never;
    }
    if (url.includes("/runtime-models/kimi-sdk")) {
      return {
        data: {
          models: [
            { id: "kimi-code/k3", label: "Kimi K3" },
            { id: "kimi-code/k2", label: "Kimi K2" },
          ],
          default: "kimi-code/k3",
        },
      } as never;
    }
    return { data: { reminders: [] } } as never;
  }) as typeof api.get;
  api.patch = (async (url: string, body?: unknown) => {
    assert.equal(url, "/agents/agent-1");
    patches.push(body as Record<string, unknown>);
    return { data: { ...agent, ...(body as Record<string, unknown>) } } as never;
  }) as typeof api.patch;

  render(
    <MemoryRouter>
      <TestIntlProvider locale="en">
        <AgentDetailPanel agent={agent as never} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Edit runtime config" }));

  const modelSelect = await screen.findByTestId("schema-runtime-model-select");
  const incompatibleEffort = await screen.findByTestId("schema-runtime-reasoning-select");
  assert.match(incompatibleEffort.textContent ?? "", /legacy-effort/);
  fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
  fireEvent.click(screen.getByRole("button", { name: "Add Variable" }));
  fireEvent.change(screen.getByPlaceholderText("KEY"), { target: { value: "UNCHANGED_EFFORT_PROBE" } });
  fireEvent.change(screen.getByPlaceholderText("value"), { target: { value: "1" } });
  const saveButton = screen.getByRole("button", { name: "Save runtime config" }) as HTMLButtonElement;
  assert.equal(saveButton.disabled, true, "an incompatible persisted effort is display-only");

  fireEvent.click(modelSelect);
  const k2Option = await screen.findByRole("option", { name: "Kimi K2" });
  fireEvent.pointerDown(k2Option);
  fireEvent.click(k2Option);
  await waitFor(() => assert.equal(screen.queryByTestId("schema-runtime-reasoning-select"), null));
  await waitFor(() => assert.equal(saveButton.disabled, false));
  fireEvent.click(saveButton);

  await waitFor(() => assert.equal(patches.length, 1));
  const submitted = patches[0] as {
    formDefinitionRef?: RuntimeFormDefinitionRef;
    reasoningEffort?: unknown;
    runtimeConfig?: { model?: { id?: string }; reasoningEffort?: unknown };
  };
  assert.deepEqual(submitted.formDefinitionRef, kimiRef);
  assert.equal(submitted.reasoningEffort, null);
  assert.equal(submitted.runtimeConfig?.model?.id, "kimi-code/k2");
  assert.equal(submitted.runtimeConfig?.reasoningEffort, null,
    "a model without effort metadata cannot receive a newly written effort");
});

test("Kimi edit without a schema ref preserves open effort ownership across safe and model-changing edits", async () => {
  const agent = {
    id: "agent-1",
    name: "legacy-kimi-open-effort",
    runtime: "kimi-sdk",
    status: "inactive",
    machineId: "machine-1",
    reasoningEffort: null,
    runtimeConfig: {
      version: 1,
      runtime: "kimi-sdk",
      model: { kind: "preset", id: "kimi-code/k3" },
      mode: { kind: "default" },
      reasoningEffort: "balanced-plus",
      envVars: null,
    },
  };
  seed(agent);
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => ({ ...machine, runtimes: ["kimi-sdk"] })),
  }));
  const patches: unknown[] = [];
  api.get = (async (url: string) => {
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } } as never;
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    if (url === "/agents/agent-1/runtime-options") {
      return {
        data: {
          context: "existing_agent",
          machineId: "machine-1",
          options: [{
            runtimeId: "kimi-sdk",
            capabilityStatus: "available",
            admissionStatus: "available_for_new",
            admissionReason: null,
            current: true,
            availableForNew: true,
            manageableForCurrentAgent: true,
            canSelectInThisContext: true,
          }],
        },
      } as never;
    }
    if (url.includes("/runtime-models/kimi-sdk")) {
      return {
        data: {
          default: "kimi-code/k3",
          models: [
            {
              id: "kimi-code/k3",
              label: "Kimi K3",
              supportedReasoningEfforts: ["balanced-plus"],
            },
            { id: "kimi-code/k2", label: "Kimi K2" },
          ],
        },
      } as never;
    }
    return { data: { reminders: [] } } as never;
  }) as typeof api.get;
  api.patch = (async (_url: string, body?: unknown) => {
    patches.push(body);
    return { data: agent } as never;
  }) as typeof api.patch;

  render(
    <MemoryRouter>
      <TestIntlProvider locale="en">
        <AgentDetailPanel agent={agent as never} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Edit runtime config" }));
  assert.equal(screen.queryByTestId("schema-runtime-reasoning-select"), null);
  assert.equal(screen.queryByTestId("runtime-reasoning-select"), null);
  assert.equal(screen.queryByTestId("kimi-reasoning-upgrade-required"), null);

  const modelSelect = screen.getByRole("combobox", { name: "Model" });
  fireEvent.click(modelSelect);
  const k2Option = await screen.findByRole("option", { name: "Kimi K2" });
  fireEvent.pointerDown(k2Option);
  fireEvent.click(k2Option);
  assert.ok(await screen.findByTestId("kimi-reasoning-upgrade-required"));
  const saveButton = screen.getByRole("button", { name: "Save runtime config" }) as HTMLButtonElement;
  assert.equal(saveButton.disabled, true, "a no-schema client cannot reselect a model carrying an open effort");

  fireEvent.click(modelSelect);
  const k3Option = await screen.findByRole("option", { name: "Kimi K3" });
  fireEvent.pointerDown(k3Option);
  fireEvent.click(k3Option);
  await waitFor(() => assert.equal(screen.queryByTestId("kimi-reasoning-upgrade-required"), null));

  // One disclosure now: env vars sit directly inside More. (The schema-driven
  // path keeps its own "Advanced", which is a separate control.)
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  fireEvent.click(screen.getByRole("button", { name: "Add Variable" }));
  fireEvent.change(screen.getByPlaceholderText("KEY"), { target: { value: "SAFE_EDIT_PROBE" } });
  fireEvent.change(screen.getByPlaceholderText("value"), { target: { value: "1" } });
  assert.equal(saveButton.disabled, false);
  fireEvent.click(saveButton);
  await waitFor(() => assert.equal(patches.length, 1));
  const submitted = patches[0] as { reasoningEffort?: unknown; runtimeConfig?: Record<string, unknown> };
  assert.equal(submitted.reasoningEffort, undefined);
  assert.equal(Object.hasOwn(submitted.runtimeConfig ?? {}, "reasoningEffort"), false);
});

test("Kimi edit without a schema ref omits effort when no open value needs protection", async () => {
  const agent = {
    id: "agent-1",
    name: "legacy-kimi-default-effort",
    runtime: "kimi-sdk",
    status: "inactive",
    machineId: "machine-1",
    reasoningEffort: null,
    runtimeConfig: {
      version: 1,
      runtime: "kimi-sdk",
      model: { kind: "preset", id: "kimi-code/k3" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
  };
  seed(agent);
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => ({ ...machine, runtimes: ["kimi-sdk"] })),
  }));
  const patches: Array<Record<string, unknown>> = [];
  api.get = (async (url: string) => {
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } } as never;
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    if (url === "/agents/agent-1/runtime-options") {
      return {
        data: {
          context: "existing_agent",
          machineId: "machine-1",
          options: [{
            runtimeId: "kimi-sdk",
            capabilityStatus: "available",
            admissionStatus: "available_for_new",
            admissionReason: null,
            current: true,
            availableForNew: true,
            manageableForCurrentAgent: true,
            canSelectInThisContext: true,
          }],
        },
      } as never;
    }
    if (url.includes("/runtime-models/kimi-sdk")) {
      return {
        data: {
          default: "kimi-code/k3",
          models: [{ id: "kimi-code/k3", label: "Kimi K3" }],
        },
      } as never;
    }
    return { data: { reminders: [] } } as never;
  }) as typeof api.get;
  api.patch = (async (url: string, body?: unknown) => {
    assert.equal(url, "/agents/agent-1");
    patches.push(body as Record<string, unknown>);
    return { data: agent } as never;
  }) as typeof api.patch;

  render(
    <MemoryRouter>
      <TestIntlProvider locale="en">
        <AgentDetailPanel agent={agent as never} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Edit runtime config" }));
  // One disclosure now: env vars sit directly inside More. (The schema-driven
  // path keeps its own "Advanced", which is a separate control.)
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  fireEvent.click(screen.getByRole("button", { name: "Add Variable" }));
  fireEvent.change(screen.getByPlaceholderText("KEY"), { target: { value: "SAFE_EDIT_PROBE" } });
  fireEvent.change(screen.getByPlaceholderText("value"), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "Save runtime config" }));
  await waitFor(() => assert.equal(patches.length, 1));

  const submitted = patches[0] as { reasoningEffort?: unknown; runtimeConfig?: Record<string, unknown> };
  assert.equal(submitted.reasoningEffort, undefined);
  assert.equal(Object.hasOwn(submitted.runtimeConfig ?? {}, "reasoningEffort"), false);
});

/**
 * Was: "…use the modal-local input sizing contract", selecting on
 * `.runtime-config-select-trigger`.
 *
 * That class was a stylesheet override holding raft-ui's own trigger contract
 * down with `!important` to preserve the pre-migration 40px look on this page
 * while Create Agent moved to 32px. Retiring the legacy arm deleted it, so the
 * old selector now matches nothing — and a test that selects nothing passes its
 * loop vacuously. Rewritten to pin what replaced it: Edit Agent's selects are on
 * the SAME field chrome as Create Agent's, which is the whole point of the
 * migration and the thing that would silently regress if a callsite dropped it.
 */
test("runtime config selects render on the field chrome, like Create Agent", async () => {
  await openRuntimeEditor(true);
  // Asserted on the TRIGGER, not the Select root: raft-ui's root renders no DOM
  // of its own, so `chrome` never appears as an attribute anywhere. It arrives
  // through context and shows up as the trigger's metric classes.
  const triggers = await waitFor(() => {
    const rendered = Array.from(document.querySelectorAll<HTMLElement>('[role="combobox"]'));
    assert.ok(rendered.length > 0, "the runtime config dialog must render select triggers");
    return rendered;
  });

  for (const trigger of triggers) {
    assert.match(
      trigger.className,
      /(?:^| )text-field(?: |$)/,
      "every runtime-config trigger must carry the field type contract — default chrome is BUTTON metrics (h-8/text-sm/font-bold), which is exactly what made Edit Agent measure differently from Create Agent",
    );
    assert.match(
      trigger.className,
      /(?:^| )font-field(?: |$)/,
      "…including weight: the old override had to fight this with a `* { font-weight: inherit !important }` descendant rule",
    );
    assert.match(
      trigger.className,
      /(?:^| )w-full(?: |$)/,
      "the trigger still spans the field",
    );
  }

  assert.equal(
    document.querySelectorAll(".runtime-config-select-trigger").length,
    0,
    "the legacy override class must not come back — it pinned this page to 40px with !important",
  );
});

test("agent Computer, status and version are separate rows; a long machine name truncates", async () => {
  const machineName = "this-is-a-very-long-computer-name-that-must-not-crush-status-metadata";
  const agent = connectedAgent(false);
  seed(agent, machineName);
  render(
    <MemoryRouter>
      <TestIntlProvider locale="en">
        <AgentDetailPanel agent={agent as never} />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const nameButton = screen.getByRole("button", { name: machineName });
  // The name is alone in its value cell: long names truncate (full name on hover).
  assert.equal(nameButton.parentElement?.children.length, 1);
  assert.match(nameButton.className, /(?:^| )truncate(?: |$)/);
  // Status and version each have their own row, so they never sit inside a long name.
  const status = screen.getByTestId("agent-computer-connection");
  assert.match(status.textContent ?? "", /Connected/i);
  assert.ok(!status.contains(nameButton));
  const version = screen.getByTestId("agent-computer-version");
  assert.ok(!version.contains(nameButton));
});

test("saved connections live inside the existing Provider field with saved choices first", async () => {
  await openRuntimeEditor(true);

  assert.ok(document.querySelector('[data-testid="edit-agent-provider-connection"]') === null);
  const providerTrigger = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="runtime-built-in-provider-select"]');
    assert.ok(el, "the unified Provider select must render when a connection is in use");
    return el;
  });
  fireEvent.click(providerTrigger);
  const saved = await screen.findByRole("option", { name: "DeepSeek · ds official api" });
  const direct = screen.getByRole("option", { name: "DeepSeek" });
  const options = screen.getAllByRole("option");
  assert.ok(options.indexOf(saved) < options.indexOf(direct));
});


test("Built-in edit restores the saved plugin selection when opening and after cancel", async () => {
  await openRuntimeEditor(true, true);
  fireEvent.click(screen.getByRole("button", { name: "More", exact: true }));
  const toggle = screen.getByRole("checkbox", { name: "Load local Pi extensions" });
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  fireEvent.click(toggle);
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  fireEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Edit runtime config" }));
  fireEvent.click(screen.getByRole("button", { name: "More", exact: true }));
  assert.equal(screen.getByRole("checkbox", { name: "Load local Pi extensions" }).getAttribute("aria-checked"), "true");
});

test("with runtime_form_v2_web on, Built-in edit uses the server's form with current values and keeps a blank secret", async () => {
  const agent = connectedAgent(false);
  agent.status = "inactive";
  seed(agent);
  setServerFeatureFlagForTests("server-1", RUNTIME_FORM_V2_WEB_FLAG_KEY, true);
  const released = releasedRuntimeFormDefinition("builtin-pi.create.v3")!;
  const builtinRef = { protocolVersion: 1, runtimeId: "builtin", schemaVersion: "builtin-pi.create.v3" };
  const fallbackGet = api.get;
  api.get = (async (url: string, ...rest: unknown[]) => {
    if (url.endsWith("/runtime-options")) {
      return {
        data: {
          context: "existing_agent",
          machineId: "machine-1",
          options: [{
            runtimeId: "builtin", capabilityStatus: "available", admissionStatus: "available_for_new",
            admissionReason: null, current: true, availableForNew: true, manageableForCurrentAgent: true,
            canSelectInThisContext: true, formDefinitionRef: builtinRef, runtimeFormV2: { protocolVersion: 2 },
          }],
        },
      } as never;
    }
    if (url === "/agents/agent-1/runtime-form") {
      return {
        data: {
          ...toRuntimeFormV2(released),
          values: { providerId: "deepseek", model: "deepseek-v4-pro", loadLocalPlugins: false, envVars: {} },
        },
      } as never;
    }
    if (url.endsWith("/runtime-forms/v2/builtin/option-sources/provider")) {
      return {
        data: {
          sourceId: "provider", kind: "select", pointer: "/providerId",
          options: [{ value: "deepseek", label: "DeepSeek", providerKind: "preset" }], defaultValue: "deepseek",
        },
      } as never;
    }
    if (url.endsWith("/runtime-forms/v2/builtin/option-sources/model")) {
      return {
        data: {
          sourceId: "model", kind: "dependent_select", pointer: "/model", dependsOn: "/providerId",
          optionsByValue: { deepseek: [{ value: "deepseek-v4-pro", label: "V4 Pro" }] },
          defaultValueByValue: { deepseek: "deepseek-v4-pro" },
          customValueAllowedByValue: { deepseek: false },
        },
      } as never;
    }
    return fallbackGet(url, ...(rest as []));
  }) as never;
  const patches: unknown[] = [];
  api.patch = (async (_url: string, body: unknown) => {
    patches.push(body);
    return { data: { ...agent } };
  }) as never;

  render(
    <MemoryRouter>
      <TestIntlProvider locale="en">
        <AgentDetailPanel agent={agent as never} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
  const opener = await waitFor(() => {
    const el = document.querySelector('[aria-label="Edit runtime config"]');
    assert.ok(el, "runtime-config edit control not found");
    return el as HTMLElement;
  });
  fireEvent.click(opener);

  // The v2 form, pre-filled by the server; the secret is blank and says so.
  await screen.findByText("Leave blank to keep the saved value.");
  screen.getByTestId("runtime-form-v2-apiKey");
  fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
  fireEvent.click(screen.getByTestId("runtime-form-v2-loadLocalPlugins"));
  fireEvent.click(screen.getByRole("button", { name: "Save runtime config" }));

  await waitFor(() => assert.equal(patches.length, 1));
  const body = patches[0] as Record<string, unknown> & { formValues: Record<string, unknown> };
  assert.deepEqual(body.formDefinitionRef, { protocolVersion: 2, runtimeId: "builtin" });
  assert.equal(body.runtimeConfig, undefined, "v2 edit submits field values, never a client-built runtimeConfig");
  assert.equal(body.formValues.providerId, "deepseek");
  assert.equal(body.formValues.model, "deepseek-v4-pro");
  assert.equal(body.formValues.loadLocalPlugins, true);
  assert.equal(body.formValues.apiKey, "", "a blank secret is sent as blank: the server keeps the stored one");
});

// v2 edit opens by the row's own `runtimeFormV2` marker, not by the v1
// `formDefinitionRef`: a runtime can have a v2 form and no v1 form at all.
function codexAgent() {
  return {
    id: "agent-1",
    name: "codexy",
    runtime: "codex",
    status: "inactive",
    machineId: "machine-1",
    reasoningEffort: null,
    runtimeConfig: {
      version: 1,
      runtime: "codex",
      model: { kind: "preset", id: "gpt-5.5" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
  };
}

async function openV2OnlyRuntimeEditor(options: { flag: boolean; requiredClientCapabilities?: unknown }) {
  const agent = codexAgent();
  seed(agent);
  setServerFeatureFlagForTests("server-1", RUNTIME_FORM_V2_WEB_FLAG_KEY, options.flag);
  const requested: string[] = [];
  const fallbackGet = api.get;
  api.get = (async (url: string, ...rest: unknown[]) => {
    requested.push(url);
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } } as never;
    if (url.endsWith("/runtime-options")) {
      return {
        data: {
          context: "existing_agent",
          machineId: "machine-1",
          options: [{
            runtimeId: "codex", capabilityStatus: "available", admissionStatus: "available_for_new",
            admissionReason: null, current: true, availableForNew: true, manageableForCurrentAgent: true,
            canSelectInThisContext: true, runtimeFormV2: { protocolVersion: 2 },
          }],
        },
      } as never;
    }
    if (url === "/agents/agent-1/runtime-form") {
      return {
        data: {
          protocolVersion: 2,
          runtimeId: "codex",
          schemaVersion: "codex.v2-test",
          ...(options.requiredClientCapabilities !== undefined ? { requiredClientCapabilities: options.requiredClientCapabilities } : {}),
          dataSchema: { type: "object", required: ["model"], properties: { model: { type: "string", title: "Served codex model" } } },
          values: { model: "gpt-5.5" },
        },
      } as never;
    }
    return fallbackGet(url, ...(rest as []));
  }) as never;
  render(
    <MemoryRouter>
      <TestIntlProvider locale="en">
        <AgentDetailPanel agent={agent as never} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
  const opener = await waitFor(() => {
    const el = document.querySelector('[aria-label="Edit runtime config"]');
    assert.ok(el, "runtime-config edit control not found");
    return el as HTMLElement;
  });
  fireEvent.click(opener);
  await waitFor(() => assert.ok(document.querySelector('[class*="card-brutal"]'), "dialog did not open"));
  return requested;
}

test("with runtime_form_v2_web on, edit of a runtime with only a v2 form uses the v2 form", async () => {
  const requested = await openV2OnlyRuntimeEditor({ flag: true });
  await screen.findByTestId("runtime-form-v2-model");
  screen.getByText("Served codex model");
  assert.ok(screen.queryByText("Fast mode") === null, "the legacy fields are replaced");
  assert.ok(requested.includes("/agents/agent-1/runtime-form"));
  assert.equal(requested.some((url) => url.includes("/runtime-form-definitions/")), false, "no v1 definition is fetched");
});

test("with runtime_form_v2_web off, the v2 marker changes nothing: edit stays on the legacy form", async () => {
  const requested = await openV2OnlyRuntimeEditor({ flag: false });
  await waitFor(() => assert.ok(requested.some((url) => url.endsWith("/runtime-options"))));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(screen.queryByTestId("runtime-form-v2-model") === null);
  screen.getByText("Fast mode"); // the legacy Codex fields render
  assert.equal(requested.some((url) => url.includes("/runtime-form")), false, "neither v2 nor v1 forms are fetched");
});

test("edit falls back to the legacy form when the v2 form requires a client capability this web build lacks", async () => {
  const requested = await openV2OnlyRuntimeEditor({ flag: true, requiredClientCapabilities: ["select.custom_value", "future.capability"] });
  await waitFor(() => assert.ok(requested.includes("/agents/agent-1/runtime-form")));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(screen.queryByTestId("runtime-form-v2-model") === null);
  assert.ok(screen.queryByText("Served codex model") === null);
  assert.ok(screen.queryByTestId("schema-runtime-unavailable") === null, "a fallback, not an error");
  screen.getByText("Fast mode"); // the legacy Codex fields render
});

// Batch 3a: the Codex v2 edit form, from the server's shared fixtures. The
// stored model is a custom one (codex.edit.json), so it is not in the list.
async function openCodexV2Edit(sourceFixture: string) {
  const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../runtime-form/fixtures/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;
  const agent = {
    ...codexAgent(),
    runtimeConfig: {
      version: 1, runtime: "codex", model: { kind: "custom", name: "my-org/codex-custom" },
      mode: { kind: "fast" }, reasoningEffort: "high", envVars: { EXAMPLE_FLAG: "1" },
    },
  };
  seed(agent);
  setServerFeatureFlagForTests("server-1", RUNTIME_FORM_V2_WEB_FLAG_KEY, true);
  const fallbackGet = api.get;
  api.get = (async (url: string, ...rest: unknown[]) => {
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } } as never;
    if (url.endsWith("/runtime-options")) {
      return {
        data: {
          context: "existing_agent",
          machineId: "machine-1",
          options: [{
            runtimeId: "codex", capabilityStatus: "available", admissionStatus: "available_for_new",
            admissionReason: null, current: true, availableForNew: true, manageableForCurrentAgent: true,
            canSelectInThisContext: true, runtimeFormV2: { protocolVersion: 2 },
          }],
        },
      } as never;
    }
    if (url === "/agents/agent-1/runtime-form") return { data: fixture("codex.edit.json") } as never;
    if (url.endsWith("/runtime-forms/v2/codex/option-sources/model")) return { data: fixture(sourceFixture) } as never;
    return fallbackGet(url, ...(rest as []));
  }) as never;
  const patches: unknown[] = [];
  api.patch = (async (_url: string, body: unknown) => {
    patches.push(body);
    return { data: { ...agent } };
  }) as never;
  render(
    <MemoryRouter>
      <TestIntlProvider locale="en">
        <AgentDetailPanel agent={agent as never} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
  const opener = await waitFor(() => {
    const el = document.querySelector('[aria-label="Edit runtime config"]');
    assert.ok(el, "runtime-config edit control not found");
    return el as HTMLElement;
  });
  fireEvent.click(opener);

  return patches;
}

test("codex v2 edit: a stored custom model shows as a typed value and is saved unchanged with the other fields", async () => {
  const patches = await openCodexV2Edit("codex.option-source.live.json");
  const typed = await screen.findByTestId("runtime-form-v2-model-custom") as HTMLInputElement;
  assert.equal(typed.value, "my-org/codex-custom", "shown as typed, not as an invalid choice");
  assert.ok(screen.queryByText("Choose one of the available options.") === null);
  assert.equal(screen.getByTestId("runtime-form-v2-model").textContent?.includes("Custom"), true);
  assert.equal(screen.getByTestId("runtime-form-v2-fastMode").getAttribute("aria-checked"), "true");
  // Change one thing (fast mode off) and save: the typed model and stored effort go back unchanged.
  fireEvent.click(screen.getByTestId("runtime-form-v2-fastMode"));
  fireEvent.click(screen.getByRole("button", { name: "Save runtime config" }));
  await waitFor(() => assert.equal(patches.length, 1));
  const body = patches[0] as { formDefinitionRef: unknown; formValues: Record<string, unknown> };
  assert.deepEqual(body.formDefinitionRef, { protocolVersion: 2, runtimeId: "codex" });
  assert.deepEqual(body.formValues, { model: "my-org/codex-custom", reasoningEffort: "high", fastMode: false, envVars: { EXAMPLE_FLAG: "1" } });
});

test("codex v2 edit: while the required model source is unavailable, save stays disabled and the status explains why", async () => {
  const patches = await openCodexV2Edit("codex.option-source.unavailable.json");
  const status = await screen.findByTestId("runtime-form-v2-model-status");
  assert.equal(status.getAttribute("data-source-status"), "unavailable");
  fireEvent.click(screen.getByTestId("runtime-form-v2-fastMode"));
  const save = screen.getByRole("button", { name: "Save runtime config" }) as HTMLButtonElement;
  assert.equal(save.disabled, true);
  fireEvent.click(save);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(patches.length, 0);
});

// Batch 3b: Claude v2 edit, from the server's shared fixtures. The stored
// custom-provider key is not in claude.edit.json's values.
test("claude v2 edit: the API key field starts blank, says blank keeps the saved key, and a save sends it blank", async () => {
  const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../runtime-form/fixtures/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;
  const agent = {
    ...codexAgent(),
    runtime: "claude",
    runtimeConfig: {
      version: 1, runtime: "claude", provider: { kind: "custom", apiUrl: "https://gateway.example.test", apiKey: "sk-v1-read" },
      model: { kind: "preset", id: "sonnet" }, mode: { kind: "fast" }, reasoningEffort: "high",
      envVars: { EXAMPLE_FLAG: "1" }, command: "/usr/local/bin/claude",
    },
  };
  seed(agent);
  setServerFeatureFlagForTests("server-1", RUNTIME_FORM_V2_WEB_FLAG_KEY, true);
  const fallbackGet = api.get;
  api.get = (async (url: string, ...rest: unknown[]) => {
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } } as never;
    if (url.endsWith("/runtime-options")) {
      return {
        data: {
          context: "existing_agent",
          machineId: "machine-1",
          options: [{
            runtimeId: "claude", capabilityStatus: "available", admissionStatus: "available_for_new",
            admissionReason: null, current: true, availableForNew: true, manageableForCurrentAgent: true,
            canSelectInThisContext: true, runtimeFormV2: { protocolVersion: 2 },
          }],
        },
      } as never;
    }
    if (url === "/agents/agent-1/runtime-form") return { data: fixture("claude.edit.json") } as never;
    if (url.endsWith("/runtime-forms/v2/claude/option-sources/provider")) return { data: fixture("claude.option-source.provider.json") } as never;
    if (url.endsWith("/runtime-forms/v2/claude/option-sources/model")) return { data: fixture("claude.option-source.fallback.json") } as never;
    return fallbackGet(url, ...(rest as []));
  }) as never;
  const patches: unknown[] = [];
  api.patch = (async (_url: string, body: unknown) => {
    patches.push(body);
    return { data: { ...agent } };
  }) as never;
  render(
    <MemoryRouter>
      <TestIntlProvider locale="en">
        <AgentDetailPanel agent={agent as never} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
  const opener = await waitFor(() => {
    const el = document.querySelector('[aria-label="Edit runtime config"]');
    assert.ok(el, "runtime-config edit control not found");
    return el as HTMLElement;
  });
  fireEvent.click(opener);

  const apiKey = await screen.findByTestId("runtime-form-v2-apiKey") as HTMLInputElement;
  assert.equal(apiKey.value, "", "the v2 form never shows the stored key");
  screen.getByText("Leave blank to keep the saved value.");
  assert.equal((screen.getByTestId("runtime-form-v2-apiUrl") as HTMLInputElement).value, "https://gateway.example.test");
  fireEvent.click(screen.getByTestId("runtime-form-v2-fastMode"));
  const save = screen.getByRole("button", { name: "Save runtime config" }) as HTMLButtonElement;
  await waitFor(() => assert.equal(save.disabled, false));
  fireEvent.click(save);
  await waitFor(() => assert.equal(patches.length, 1));
  const body = patches[0] as { formDefinitionRef: unknown; formValues: Record<string, unknown> };
  assert.deepEqual(body.formDefinitionRef, { protocolVersion: 2, runtimeId: "claude" });
  assert.deepEqual(body.formValues, {
    provider: "custom",
    apiUrl: "https://gateway.example.test",
    apiKey: "",
    model: "sonnet",
    reasoningEffort: "high",
    fastMode: false,
    command: "/usr/local/bin/claude",
    envVars: { EXAMPLE_FLAG: "1" },
  });
});

// Batch 4: Pi v2 edit, from the server's shared fixtures. The stored DeepSeek
// key is not in pi.edit.json's values.
test("pi v2 edit: the DeepSeek key field starts blank, says blank keeps the saved key, and a save sends it blank with the provider's model", async () => {
  const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../runtime-form/fixtures/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;
  const agent = {
    ...codexAgent(),
    runtime: "pi",
    model: "deepseek/deepseek-v4-pro",
    runtimeConfig: {
      version: 1, runtime: "pi", provider: { kind: "pi-builtin", providerId: "deepseek", apiKey: "sk-v1-read" },
      model: { kind: "preset", id: "deepseek/deepseek-v4-pro" }, mode: { kind: "default" }, reasoningEffort: "high",
      envVars: { EXAMPLE_FLAG: "1" },
    },
  };
  seed(agent);
  setServerFeatureFlagForTests("server-1", RUNTIME_FORM_V2_WEB_FLAG_KEY, true);
  const fallbackGet = api.get;
  api.get = (async (url: string, ...rest: unknown[]) => {
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } } as never;
    if (url.endsWith("/runtime-options")) {
      return {
        data: {
          context: "existing_agent",
          machineId: "machine-1",
          options: [{
            runtimeId: "pi", capabilityStatus: "available", admissionStatus: "available_for_new",
            admissionReason: null, current: true, availableForNew: true, manageableForCurrentAgent: true,
            canSelectInThisContext: true, runtimeFormV2: { protocolVersion: 2 },
          }],
        },
      } as never;
    }
    if (url === "/agents/agent-1/runtime-form") return { data: fixture("pi.edit.json") } as never;
    if (url.endsWith("/runtime-forms/v2/pi/option-sources/provider")) return { data: fixture("pi.option-source.provider.json") } as never;
    if (url.endsWith("/runtime-forms/v2/pi/option-sources/model")) return { data: fixture("pi.option-source.fallback.json") } as never;
    if (url.endsWith("/runtime-forms/v2/pi/option-sources/providerModel")) return { data: fixture("pi.option-source.provider-model.json") } as never;
    return fallbackGet(url, ...(rest as []));
  }) as never;
  const patches: unknown[] = [];
  api.patch = (async (_url: string, body: unknown) => {
    patches.push(body);
    return { data: { ...agent } };
  }) as never;
  render(
    <MemoryRouter>
      <TestIntlProvider locale="en">
        <AgentDetailPanel agent={agent as never} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
  const opener = await waitFor(() => {
    const el = document.querySelector('[aria-label="Edit runtime config"]');
    assert.ok(el, "runtime-config edit control not found");
    return el as HTMLElement;
  });
  fireEvent.click(opener);

  const apiKey = await screen.findByTestId("runtime-form-v2-apiKey") as HTMLInputElement;
  assert.equal(apiKey.value, "", "the v2 form never shows the stored key");
  screen.getByText("Leave blank to keep the saved value.");
  screen.getByTestId("runtime-form-v2-providerModel");
  assert.ok(screen.queryByTestId("runtime-form-v2-model") === null, "the Configured model field is hidden for DeepSeek");
  // Change the model in the provider's own list, leave the key blank.
  const providerModel = screen.getByTestId("runtime-form-v2-providerModel");
  fireEvent.click(providerModel);
  const flash = await screen.findByRole("option", { name: "DeepSeek V4.1 Flash" });
  fireEvent.pointerDown(flash);
  fireEvent.click(flash);
  const save = screen.getByRole("button", { name: "Save runtime config" }) as HTMLButtonElement;
  await waitFor(() => assert.equal(save.disabled, false));
  fireEvent.click(save);
  await waitFor(() => assert.equal(patches.length, 1));
  const body = patches[0] as { formDefinitionRef: unknown; formValues: Record<string, unknown> };
  assert.deepEqual(body.formDefinitionRef, { protocolVersion: 2, runtimeId: "pi" });
  // The effort follows the model change back to the runtime default (a derived field).
  assert.deepEqual(body.formValues, {
    provider: "deepseek",
    apiKey: "",
    providerModel: "deepseek/deepseek-flash",
    providerReasoningEffort: null,
    envVars: { EXAMPLE_FLAG: "1" },
  });
});
