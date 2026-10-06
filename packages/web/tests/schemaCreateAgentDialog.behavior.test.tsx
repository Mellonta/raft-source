import "./helpers/domSetup";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertOptionFieldLabels } from "./helpers/optionFieldLabels";

import type { ComponentProps, ReactElement } from "react";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { RenderOptions } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import {
  KIMI_SDK_FORM_DEFINITION_REF,
  PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
} from "@botiverse/raft-shared";
import { toRuntimeFormV2 } from "@botiverse/raft-runtime-form";
import type {
  AgentCreateFormDefinition,
  ResolvedAgentCreateFormDefinition,
  RuntimeFormDefinitionRef,
  RuntimeSelectionOption,
} from "@botiverse/raft-shared";
import api from "../src/api/client";
import { ActionCard } from "../src/components/actions/ActionCard";
import CreateAgentDialog from "../src/components/agent/CreateAgentDialog";
import { useAgentStore } from "../src/store/agentStore";
import type { Agent } from "../src/store/agentStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import {
  prefetchServerFeatureFlags,
  resetServerFeatureFlagsForTests,
  RUNTIME_FORM_V2_WEB_FLAG_KEY,
} from "../src/store/serverFeatureFlags";
import { writeCreateAgentLastConfig } from "../src/utils/createAgentLastConfig";
import { TestIntlProvider } from "./helpers/intl";

function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(<TestIntlProvider>{ui}</TestIntlProvider>, options);
}

const originalGet = api.get;
const originalPost = api.post;

const ref: RuntimeFormDefinitionRef = {
  protocolVersion: 1,
  runtimeId: "builtin",
  schemaVersion: "builtin-pi.create.v2",
};

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

function definitionFixture(): ResolvedAgentCreateFormDefinition {
  return {
    ...ref,
    dataSchema: {
      type: "object",
      additionalProperties: false,
      required: ["providerId", "apiKey", "model"],
      properties: {
        providerId: { type: "string", title: "Provider", minLength: 1 },
        apiKey: { type: "string", title: "API Key", minLength: 1, writeOnly: true },
        baseUrl: { type: "string", title: "Base URL", minLength: 1, format: "uri" },
        supportsImageInput: { type: "boolean", title: "Image input" },
        model: { type: "string", title: "Model", minLength: 1 },
        envVars: { type: "object", title: "Environment Variables", additionalProperties: { type: "string" } },
      },
    },
    uiSchema: {
      order: ["providerId", "apiKey", "baseUrl", "supportsImageInput", "model", "envVars"],
      layout: { advanced: ["/envVars"] },
      visibility: [
        { pointer: "/baseUrl", when: { pointer: "/providerId", in: ["openai-compatible"] } },
        { pointer: "/supportsImageInput", when: { pointer: "/providerId", in: ["openai-compatible"] } },
      ],
      localization: {
        providerId: { label: "Served Provider" },
        apiKey: { label: "Served API Key" },
        baseUrl: { label: "Served Base URL" },
        supportsImageInput: {
          label: "Served Image Input",
          hint: "Enable only for image-capable gateways.",
        },
        model: { label: "Served Model" },
        envVars: { label: "Served Environment" },
      },
    },
    capabilities: {
      providerKinds: ["preset", "gateway"],
      writeOnlyPointers: ["/apiKey"],
      forbiddenPointers: ["/hostUserState"],
    },
    optionSources: {
      provider: {
        ...ref,
        sourceId: "provider",
        kind: "select",
        pointer: "/providerId",
        options: [
          { value: "deepseek", label: "Server DeepSeek", providerKind: "preset" },
          { value: "openai-compatible", label: "Server Gateway", providerKind: "gateway" },
        ],
        defaultValue: "deepseek",
      },
      model: {
        ...ref,
        sourceId: "model",
        kind: "dependent_select",
        pointer: "/model",
        dependsOn: "/providerId",
        optionsByValue: {
          deepseek: [{ value: "deepseek/deepseek-v4-pro", label: "Server Model" }],
          "openai-compatible": [],
        },
        defaultValueByValue: { deepseek: "deepseek/deepseek-v4-pro" },
        customValueAllowedByValue: { deepseek: false, "openai-compatible": true },
      },
    },
  };
}

function definitionResponse() {
  const definition = definitionFixture();
  return {
    ...definition,
    optionSources: {
      provider: {
        ...ref,
        sourceId: "provider",
        kind: "select" as const,
        pointer: "/providerId",
      },
      model: {
        ...ref,
        sourceId: "model",
        kind: "dependent_select" as const,
        pointer: "/model",
        dependsOn: "/providerId",
      },
    },
  };
}

function runtimeOption(runtimeId: string, formDefinitionRef?: RuntimeFormDefinitionRef): RuntimeSelectionOption {
  return {
    runtimeId,
    capabilityStatus: "available",
    admissionStatus: "available_for_new",
    admissionReason: null,
    current: false,
    availableForNew: true,
    manageableForCurrentAgent: false,
    canSelectInThisContext: true,
    formDefinitionRef,
  };
}

function makeAgent(runtime: string, runtimeConfig: unknown): Agent {
  return {
    id: `agent-${runtime}`,
    serverId: "server-1",
    name: "Alice",
    displayName: "Alice",
    avatarUrl: "pixel:mug",
    description: null,
    status: "starting",
    model: runtime === "builtin" ? "deepseek/deepseek-v4-pro" : "gpt-5",
    runtime,
    serverRole: null,
    runtimeConfig: runtimeConfig as Agent["runtimeConfig"],
    lastRuntimeError: null,
    reasoningEffort: null,
    executionMode: "byoc",
    envVars: null,
    machineId: "machine-1",
    creatorType: "user",
    creatorId: "owner-1",
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: "2026-07-22T00:00:00.000Z",
  };
}

function seedStores(runtimes: string[]) {
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Launch",
      slug: "launch",
      avatarUrl: null,
      ownerId: "owner-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-07-22T00:00:00.000Z",
    },
    billing: null,
    loadBilling: async () => undefined,
  } as never);
  useMachineStore.setState({
    machines: [{
      id: "machine-1",
      name: "Mac",
      description: null,
      status: "online",
      statusVersion: 1,
      apiKeyPrefix: null,
      runtimes,
      hostname: "mac.local",
      os: "darwin",
      daemonVersion: "1.0.13",
      lastHeartbeat: "2026-07-22T00:00:00.000Z",
      createdAt: "2026-07-22T00:00:00.000Z",
    }],
  } as never);
  useChannelStore.setState({ channels: [] } as never);
  useAgentStore.setState({ agents: [], loading: false } as never);
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="create-agent-location">{location.pathname}{location.search}</output>;
}

function renderDialog({
  initialEntry = "/s/launch/channel/source",
  ...props
}: Partial<ComponentProps<typeof CreateAgentDialog>> & { initialEntry?: string } = {}) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <CreateAgentDialog
        defaultMachineId="machine-1"
        onClose={() => undefined}
        {...props}
      />
    </MemoryRouter>,
  );
}

function mockCodexCreateApi(createdId = "agent-created") {
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    if (url.endsWith("/runtime-options")) {
      return { data: { context: "new_agent", machineId: "machine-1", options: [runtimeOption("codex")] } } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    if (/^\/actions\/[^/]+\/event$/.test(url)) return { data: {} } as never;
    assert.equal(url, "/agents");
    const request = body as { runtime: string; runtimeConfig: unknown };
    return {
      data: {
        ...makeAgent(request.runtime, request.runtimeConfig),
        id: createdId,
      },
    } as never;
  }) as typeof api.post;
}

async function submitManagedAgent(name = "Alice") {
  await waitFor(() => assert.ok(screen.getAllByText("Codex CLI").length > 0));
  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: name } });
  const create = screen.getByRole("button", { name: "Create Agent" }) as HTMLButtonElement;
  await waitFor(() => assert.equal(create.disabled, false));
  fireEvent.click(create);
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  api.get = originalGet;
  api.post = originalPost;
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  resetServerFeatureFlagsForTests();
});

test("the mounted onboarding form owns its narrow-viewport scroll boundary", async () => {
  seedStores(["builtin"]);
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    if (url.endsWith("/runtime-options")) {
      return { data: { context: "new_agent", machineId: "machine-1", options: [runtimeOption("builtin", ref)] } } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/provider?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.provider } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/model?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.model } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionResponse() } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  renderDialog({ onboarding: true });

  await waitFor(() => {
    const onboardingForm = document.querySelector("#create-cindy-onboarding-form");
    const narrowFormScrollport = onboardingForm?.querySelector(".overflow-y-auto");
    assert.ok(
      narrowFormScrollport,
      "the mounted onboarding form keeps its own narrow-viewport scroll boundary",
    );
    assert.match(
      narrowFormScrollport.className,
      /max-h-\[min\(70dvh,calc\(100dvh-12rem\)\)\]/,
      "the mounted onboarding form keeps the viewport-bounded height",
    );
  });
});

test("Built-in ref fetches the exact definition, renders served options, and forwards the exact schema payload", async () => {
  seedStores(["builtin"]);
  const getCalls: string[] = [];
  const postBodies: unknown[] = [];
  api.get = (async (url: string) => {
    getCalls.push(url);
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    if (url.endsWith("/runtime-options")) {
      return { data: { context: "new_agent", machineId: "machine-1", options: [runtimeOption("builtin", ref)] } } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/provider?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.provider } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/model?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.model } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionResponse() } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/agents");
    postBodies.push(body);
    const request = body as { runtime: string; runtimeConfig: unknown };
    return { data: makeAgent(request.runtime, request.runtimeConfig) } as never;
  }) as typeof api.post;

  renderDialog();

  assert.ok(await screen.findByText("Server DeepSeek"));
  assert.ok(screen.getAllByText("Server Model").length > 0);
  assert.ok(getCalls.includes(
    "/servers/server-1/machines/machine-1/runtime-form-definitions/builtin?schemaVersion=builtin-pi.create.v2",
  ));
  assert.ok(getCalls.includes(
    "/servers/server-1/machines/machine-1/runtime-form-definitions/builtin/option-sources/provider?schemaVersion=builtin-pi.create.v2",
  ));
  assert.ok(getCalls.includes(
    "/servers/server-1/machines/machine-1/runtime-form-definitions/builtin/option-sources/model?schemaVersion=builtin-pi.create.v2",
  ));
  assert.equal(
    getCalls.includes("/provider-connections"),
    false,
    "disabled provider connections must not be discoverable from Agent creation",
  );
  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "Alice" } });
  fireEvent.change(screen.getByTestId("schema-runtime-api-key"), { target: { value: "schema-ui-secret" } });
  assert.equal(
    screen.queryAllByRole("button", { name: "More" }).length,
    0,
    "schema-driven Built-in must not render an empty More disclosure shell",
  );
  const advancedDisclosure = screen.getByRole("button", { name: "Advanced" });
  assert.equal(advancedDisclosure.getAttribute("aria-expanded"), "false");
  assert.equal(screen.queryAllByText("Environment Variables").length, 0);
  fireEvent.click(advancedDisclosure);
  assert.equal(advancedDisclosure.getAttribute("aria-expanded"), "true");
  assert.ok(screen.getByText("Environment Variables"));
  fireEvent.click(screen.getByRole("button", { name: "Add Variable" }));
  fireEvent.change(screen.getByPlaceholderText("KEY"), { target: { value: "TEAM_FLAG" } });
  fireEvent.change(screen.getByPlaceholderText("value"), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

  await waitFor(() => assert.equal(postBodies.length, 1));
  const submitted = postBodies[0] as Record<string, unknown> & {
    runtimeConfig: { provider: Record<string, unknown>; envVars: Record<string, string> };
  };
  assert.deepEqual(submitted.formDefinitionRef, ref);
  assert.equal(submitted.runtime, "builtin");
  assert.deepEqual(submitted.runtimeConfig.provider, {
    kind: "preset",
    providerId: "deepseek",
    apiKey: "schema-ui-secret",
  });
  assert.deepEqual(submitted.runtimeConfig.envVars, { TEAM_FLAG: "1" });
  assert.equal(submitted.envVars, undefined, "schema env belongs only inside runtimeConfig");
  assert.equal(submitted.apiKey, undefined, "writeOnly input is never duplicated at top level");
});

test("Kimi create uses the served model-scoped effort metadata without cross-model leakage", async () => {
  seedStores(["kimi-sdk"]);
  const postBodies: unknown[] = [];
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    if (url.endsWith("/runtime-options")) {
      return {
        data: {
          context: "new_agent",
          machineId: "machine-1",
          options: [runtimeOption("kimi-sdk", kimiRef)],
        },
      } as never;
    }
    if (url.includes("/runtime-form-definitions/kimi-sdk/option-sources/model?schemaVersion=")) {
      return { data: kimiDefinitionFixture().optionSources.model } as never;
    }
    if (url.includes("/runtime-form-definitions/kimi-sdk?schemaVersion=")) {
      return { data: kimiDefinitionResponse() } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/agents");
    postBodies.push(body);
    const request = body as { runtime: string; runtimeConfig: unknown };
    return { data: makeAgent(request.runtime, request.runtimeConfig) } as never;
  }) as typeof api.post;

  renderDialog();

  const modelSelect = await screen.findByTestId("schema-runtime-model-select");
  assert.ok(screen.getByTestId("schema-runtime-reasoning-select"));
  fireEvent.click(modelSelect);
  const k2Option = await screen.findByRole("option", { name: "Kimi K2" });
  fireEvent.pointerDown(k2Option);
  fireEvent.click(k2Option);
  await waitFor(() => assert.equal(screen.queryByTestId("schema-runtime-reasoning-select"), null));

  fireEvent.click(modelSelect);
  const k3Option = await screen.findByRole("option", { name: "Kimi K3" });
  fireEvent.pointerDown(k3Option);
  fireEvent.click(k3Option);
  assert.ok(await screen.findByTestId("schema-runtime-reasoning-select"));

  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "KimiAlice" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await waitFor(() => assert.equal(postBodies.length, 1));
  const submitted = postBodies[0] as Record<string, unknown> & {
    runtimeConfig: { model: { id: string }; reasoningEffort: string | null };
  };
  assert.deepEqual(submitted.formDefinitionRef, kimiRef);
  assert.equal(submitted.runtime, "kimi-sdk");
  assert.equal(submitted.runtimeConfig.model.id, "kimi-code/k3");
  assert.equal(submitted.runtimeConfig.reasoningEffort, "balanced-plus");
  assert.equal(submitted.reasoningEffort, undefined, "open Kimi effort stays inside runtimeConfig");
});

test("Kimi create without a schema ref hides and omits the unmanaged effort field", async () => {
  seedStores(["kimi-sdk"]);
  const postBodies: unknown[] = [];
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    if (url.endsWith("/runtime-options")) {
      return {
        data: {
          context: "new_agent",
          machineId: "machine-1",
          options: [runtimeOption("kimi-sdk")],
        },
      } as never;
    }
    if (url.includes("/runtime-models/kimi-sdk")) {
      return {
        data: {
          default: "kimi-code/kimi-for-coding",
          models: [{
            id: "kimi-code/kimi-for-coding",
            label: "Kimi for Coding",
            supportedReasoningEfforts: ["balanced-plus"],
            defaultReasoningEffort: "balanced-plus",
          }],
        },
      } as never;
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/agents");
    postBodies.push(body);
    const request = body as { runtime: string; runtimeConfig: unknown };
    return { data: makeAgent(request.runtime, request.runtimeConfig) } as never;
  }) as typeof api.post;

  renderDialog();
  await waitFor(() => assert.ok(screen.getAllByText(/Kimi/).length > 0));
  assert.equal(screen.queryByTestId("schema-runtime-reasoning-select"), null);
  assert.equal(screen.queryByTestId("runtime-reasoning-select"), null);

  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "LegacyKimi" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await waitFor(() => assert.equal(postBodies.length, 1));

  const submitted = postBodies[0] as {
    formDefinitionRef?: unknown;
    reasoningEffort?: unknown;
    runtimeConfig: Record<string, unknown>;
  };
  assert.equal(submitted.formDefinitionRef, undefined);
  assert.equal(submitted.reasoningEffort, undefined);
  assert.equal(
    Object.hasOwn(submitted.runtimeConfig, "reasoningEffort"),
    false,
    "a no-schema client must not synthesize even a null Kimi effort field",
  );
});

test("a saved provider leads the Provider selector, keeps its schema, and submits only its reference", async () => {
  seedStores(["builtin"]);
  const postBodies: unknown[] = [];
  api.get = (async (url: string) => {
    if (url === "/provider-connections") {
      return { data: { connections: [{
        id: "11111111-1111-4111-8111-111111111111",
        name: "Team DeepSeek",
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
        lastCheckedAt: "2026-08-03T08:00:00.000Z",
        lastErrorCategory: null,
        createdAt: "2026-08-03T08:00:00.000Z",
        updatedAt: "2026-08-03T08:00:00.000Z",
      }] } } as never;
    }
    if (url.endsWith("/runtime-options")) {
      return { data: { context: "new_agent", machineId: "machine-1", options: [runtimeOption("builtin", ref)] } } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/provider?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.provider } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/model?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.model } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionResponse() } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      return {
        data: { evaluations: [{ key: PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY, enabled: true }] },
      } as never;
    }
    assert.equal(url, "/agents");
    postBodies.push(body);
    const request = body as { runtime: string; runtimeConfig: unknown };
    return { data: makeAgent(request.runtime, request.runtimeConfig) } as never;
  }) as typeof api.post;

  await prefetchServerFeatureFlags("server-1");
  renderDialog();
  const providerSelect = await screen.findByTestId("schema-runtime-provider-select");
  assert.ok(
    screen.queryByText("Provider connection") === null,
    "the separate Provider connection field must stay retired",
  );
  fireEvent.click(providerSelect);
  assert.ok(await screen.findByText("Saved providers"));
  assert.ok(screen.getByText("Direct setup"));
  const connectionOption = await screen.findByRole("option", { name: "Server DeepSeek · Team DeepSeek" });
  const providerOptions = screen.getAllByRole("option").map((option) => option.textContent?.trim());
  assert.ok(
    providerOptions.indexOf("Server DeepSeek · Team DeepSeek") < providerOptions.indexOf("Server DeepSeek"),
    "saved providers must appear before direct setup",
  );
  fireEvent.pointerDown(connectionOption);
  fireEvent.click(connectionOption);
  const apiKey = await screen.findByTestId("schema-runtime-api-key");
  assert.equal(apiKey.hasAttribute("disabled"), true);
  assert.equal(apiKey.getAttribute("placeholder"), "Provided by “Team DeepSeek”");
  assert.equal((apiKey as HTMLInputElement).value, "");
  assert.ok(screen.getByText("Served Model"), "the saved DeepSeek connection keeps the DeepSeek schema");
  const editButton = screen.getByRole("button", { name: "Edit saved provider" });
  fireEvent.click(editButton);
  const editDialog = await screen.findByTestId("provider-connection-edit-dialog");
  const editSecret = editDialog.querySelector<HTMLInputElement>('input[type="password"]');
  assert.ok(editSecret, "the Provider-field action must open the shared connection editor");
  assert.equal(editSecret.value, "", "editing must not hydrate the stored credential into the DOM");
  const closeEdit = editDialog.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
  assert.ok(closeEdit, "the shared connection editor must remain independently closable");
  fireEvent.click(closeEdit);
  await waitFor(() =>
    assert.ok(screen.queryByTestId("provider-connection-edit-dialog") === null),
  );
  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "Alice" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

  await waitFor(() => assert.equal(postBodies.length, 1));
  const submitted = postBodies[0] as {
    runtimeConfig: { provider: Record<string, unknown> };
  };
  assert.deepEqual(submitted.runtimeConfig.provider, {
    kind: "connection",
    connectionId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(JSON.stringify(submitted).includes("apiKey"), false);
});

test("v2 flag on: builtin create still renders the saved-provider selector", async () => {
  seedStores(["builtin"]);
  api.get = (async (url: string) => {
    if (url === "/provider-connections") {
      return { data: { connections: [{
        id: "22222222-2222-4222-8222-222222222222",
        name: "Team DeepSeek",
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
        lastCheckedAt: "2026-08-03T08:00:00.000Z",
        lastErrorCategory: null,
        createdAt: "2026-08-03T08:00:00.000Z",
        updatedAt: "2026-08-03T08:00:00.000Z",
      }] } } as never;
    }
    if (url.endsWith("/runtime-options")) {
      return { data: { context: "new_agent", machineId: "machine-1", options: [{
        ...runtimeOption("builtin", ref),
        runtimeFormV2: { protocolVersion: 2 },
      }] } } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/provider?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.provider } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/model?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.model } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionResponse() } as never;
    }
    if (url.includes("/runtime-forms/v2/")) {
      // If create ever goes v2 for builtin this endpoint gets hit and the v2
      // form would replace the Provider block — the bug this test guards.
      throw new Error(`builtin create must not fetch the v2 form: ${url}`);
    }
    if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return {
        data: { evaluations: [
          { key: PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY, enabled: true },
          { key: RUNTIME_FORM_V2_WEB_FLAG_KEY, enabled: true },
        ] },
      } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;

  await prefetchServerFeatureFlags("server-1");
  renderDialog();
  const providerSelect = await screen.findByTestId("schema-runtime-provider-select");
  fireEvent.click(providerSelect);
  assert.ok(
    await screen.findByText("Saved providers"),
    "with runtime_form_v2_web on, builtin create must stay on the schema form that carries the saved-provider group",
  );
  assert.ok(screen.getByText("Server DeepSeek · Team DeepSeek"));
});

test("gateway image-input checkbox resets on provider switch and submits only when checked", async () => {
  seedStores(["builtin"]);
  const postBodies: unknown[] = [];
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    if (url.endsWith("/runtime-options")) {
      return { data: { context: "new_agent", machineId: "machine-1", options: [runtimeOption("builtin", ref)] } } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/provider?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.provider } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/model?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.model } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionResponse() } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/agents");
    postBodies.push(body);
    const request = body as { runtime: string; runtimeConfig: unknown };
    return { data: makeAgent(request.runtime, request.runtimeConfig) } as never;
  }) as typeof api.post;

  renderDialog();
  assert.ok(await screen.findByText("Server DeepSeek"));
  const providerSelect = screen.getByTestId("schema-runtime-provider-select");
  const chooseProvider = async (name: string) => {
    fireEvent.click(providerSelect);
    const option = await screen.findByRole("option", { name });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
  };

  const advancedDisclosure = screen.getByRole("button", { name: "Advanced" });
  fireEvent.click(advancedDisclosure);
  assert.ok(screen.getByText("Environment Variables"));
  await chooseProvider("Server Gateway");
  assert.equal(
    screen.getByRole("button", { name: "Advanced" }).getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(screen.queryAllByText("Environment Variables").length, 0);
  // `aria-checked`, not `.checked`: this is raft-ui's Switch, which renders a
  // `role="switch"` element plus a hidden input, so the input no longer carries
  // the test id. The behaviour asserted is unchanged — verified by driving the
  // control before this assertion was touched.
  const imageInput = await screen.findByTestId("schema-runtime-supports-image-input");

  // "Served Image Input" — the SCHEMA's own label — not the hardcoded
  // "Supports image input" this asserted before.
  //
  // The Card is still here; what changed is that the OPTION NAME now prefers the
  // schema-supplied label. Previously the field rendered the schema label while
  // the CardTitle inside it hardcoded a different string, so the control was
  // announced by the hardcoded one and the runtime form definition's own copy
  // was overruled at the callsite. The schema wins the name it announces, which
  // is the point of a server-driven form definition; the Field keeps its own
  // generic group label above it (asserted just below).
  const imageInputName = (imageInput.getAttribute("aria-labelledby") ?? "")
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
    .filter(Boolean)
    .join(" ");
  assert.equal(imageInputName, "Served Image Input",
    `a screen reader must hear the schema's own label; it heard "${imageInputName}"`);

  // Group label vs option name — the level no assertion covered, which is how
  // the option name got hoisted into the group label and shipped twice.
  assertOptionFieldLabels(imageInput, {
    groupLabel: "Image input",
    optionName: "Served Image Input",
  });

  // The option's name lives on the card's own title again, and the card renders
  // as a <label>, so the whole option is the hit target — no `for` needed, and
  // the field declines adoption because its content is a Card rather than one
  // control. What changed versus the original is the chrome: `variant="option"`
  // puts it at control elevation with a field-scale title.
  const optionTitle = document.getElementById("schema-image-input-title");
  assert.ok(optionTitle, "the option must carry its own title");
  assert.equal(
    (optionTitle.textContent ?? "").trim(),
    "Served Image Input",
    "the option title is what names the control",
  );
  assert.ok(
    optionTitle.closest('[data-slot="card"]'),
    "the option must be a Card — that is what makes the whole row clickable and gives it the option chrome",
  );
  assert.equal(imageInput.getAttribute("aria-checked"), "false");
  fireEvent.click(imageInput);
  assert.equal(imageInput.getAttribute("aria-checked"), "true");

  await chooseProvider("Server DeepSeek");
  assert.equal(screen.queryByTestId("schema-runtime-supports-image-input"), null);
  await chooseProvider("Server Gateway");
  const resetImageInput = await screen.findByTestId("schema-runtime-supports-image-input");
  assert.equal(resetImageInput.getAttribute("aria-checked"), "false");
  fireEvent.click(resetImageInput);

  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "GatewayAlice" } });
  fireEvent.change(screen.getByTestId("schema-runtime-api-key"), { target: { value: "schema-gateway-secret" } });
  fireEvent.change(screen.getByTestId("schema-runtime-base-url"), { target: { value: "https://gateway.example.test/v1" } });
  fireEvent.change(screen.getByTestId("schema-runtime-custom-model"), { target: { value: "acme/vision" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

  await waitFor(() => assert.equal(postBodies.length, 1));
  const submitted = postBodies[0] as {
    runtimeConfig: { provider: Record<string, unknown> };
  };
  assert.deepEqual(submitted.runtimeConfig.provider, {
    kind: "gateway",
    providerId: "openai-compatible",
    baseUrl: "https://gateway.example.test/v1",
    apiKey: "schema-gateway-secret",
    supportsImageInput: true,
  });
});

test("remembered Built-in waits for the complete catalog instead of committing a legacy fallback", async () => {
  seedStores(["codex", "builtin"]);
  writeCreateAgentLastConfig("server-1", {
    machineId: "machine-1",
    runtime: "builtin",
    model: "deepseek/deepseek-v4-pro",
    customModelMode: false,
  });
  const getCalls: string[] = [];
  let releaseDefinition!: () => void;
  const definitionGate = new Promise<void>((resolve) => {
    releaseDefinition = resolve;
  });
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    getCalls.push(url);
    if (url.endsWith("/runtime-options")) {
      return {
        data: {
          context: "new_agent",
          machineId: "machine-1",
          options: [runtimeOption("codex"), runtimeOption("builtin", ref)],
        },
      } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/provider?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.provider } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/model?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.model } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin?schemaVersion=builtin-pi.create.v2")) {
      await definitionGate;
      return { data: definitionResponse() } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  renderDialog();

  await waitFor(() => {
    assert.equal(getCalls.filter((url) => url.includes("/runtime-form-definitions/builtin?")).length, 1);
  });
  const runtimeSelect = screen.getAllByRole("combobox")[1];
  assert.ok(runtimeSelect);
  assert.doesNotMatch(runtimeSelect.textContent ?? "", /Codex CLI/);
  assert.equal(screen.queryByText("Loading runtime configuration…"), null);

  releaseDefinition();
  await waitFor(() => {
    assert.match(runtimeSelect.textContent ?? "", /Built-in Pi/);
    assert.equal(getCalls.filter((url) => url.includes("/runtime-form-definitions/")).length, 3);
  });
  assert.ok(screen.getByText("Server DeepSeek"));
  assert.ok(screen.getByTestId("schema-runtime-api-key"));
  assert.ok(screen.getAllByText("Server Model").length > 0);
  assert.equal(screen.queryByText("Loading runtime configuration…"), null);
  fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
  assert.ok(screen.getByText("Environment Variables"));

  const requestCountBeforeSwitch = getCalls.filter((url) => url.includes("/runtime-form-definitions/")).length;
  fireEvent.click(runtimeSelect);
  const codexOption = await screen.findByRole("option", { name: "Codex CLI" });
  fireEvent.pointerDown(codexOption);
  fireEvent.click(codexOption);
  await waitFor(() => assert.match(runtimeSelect.textContent ?? "", /Codex CLI/));
  fireEvent.click(runtimeSelect);
  const builtInOption = await screen.findByRole("option", { name: "Built-in Pi" });
  fireEvent.pointerDown(builtInOption);
  fireEvent.click(builtInOption);

  await waitFor(() => assert.match(runtimeSelect.textContent ?? "", /Built-in Pi/));
  assert.equal(
    getCalls.filter((url) => url.includes("/runtime-form-definitions/")).length,
    requestCountBeforeSwitch,
  );
  assert.equal(
    screen.getByRole("button", { name: "Advanced" }).getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(screen.queryAllByText("Environment Variables").length, 0);
  assert.equal(screen.queryByText("Loading runtime configuration…"), null);
});

test("dialog preloads Built-in definition sources before selection and runtime switching is request-free", async () => {
  seedStores(["codex", "builtin"]);
  const getCalls: string[] = [];
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    getCalls.push(url);
    if (url.endsWith("/runtime-options")) {
      return {
        data: {
          context: "new_agent",
          machineId: "machine-1",
          options: [runtimeOption("codex"), runtimeOption("builtin", ref)],
        },
      } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/provider?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.provider } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/model?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.model } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionResponse() } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  renderDialog();

  await waitFor(() => {
    assert.equal(getCalls.filter((url) => url.includes("/runtime-form-definitions/")).length, 3);
  });
  const runtimeSelect = screen.getAllByRole("combobox")[1];
  assert.ok(runtimeSelect);
  assert.match(runtimeSelect.textContent ?? "", /Codex CLI/);
  assert.equal(screen.queryByText("Loading runtime configuration…"), null);
  const requestCountBeforeSelection = getCalls.filter((url) => url.includes("/runtime-form-definitions/")).length;

  fireEvent.click(runtimeSelect);
  const builtInOption = await screen.findByRole("option", { name: "Built-in Pi" });
  fireEvent.pointerDown(builtInOption);
  fireEvent.click(builtInOption);

  assert.ok(await screen.findByText("Server DeepSeek"));
  assert.ok(screen.getByTestId("schema-runtime-api-key"));
  assert.ok(screen.getAllByText("Server Model").length > 0);
  assert.equal(screen.queryByText("Loading runtime configuration…"), null);
  await waitFor(() => {
    assert.equal(
      getCalls.filter((url) => url.includes("/runtime-form-definitions/")).length,
      requestCountBeforeSelection,
    );
  });
});

test("changing Computer preloads only the new Computer catalog", async () => {
  seedStores(["codex", "builtin"]);
  useMachineStore.setState((state) => ({
    machines: [
      state.machines[0],
      {
        ...state.machines[0],
        id: "machine-2",
        name: "Studio",
        hostname: "studio.local",
      },
    ],
  }));
  const getCalls: string[] = [];
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    getCalls.push(url);
    if (url.endsWith("/runtime-options")) {
      const machineId = url.includes("/machines/machine-2/") ? "machine-2" : "machine-1";
      return {
        data: {
          context: "new_agent",
          machineId,
          options: [runtimeOption("codex"), runtimeOption("builtin", ref)],
        },
      } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/provider?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.provider } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/model?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.model } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionResponse() } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  renderDialog();
  const definitionCallsFor = (machineId: string) => getCalls.filter(
    (url) => url.includes(`/machines/${machineId}/runtime-form-definitions/`),
  ).length;
  await waitFor(() => assert.equal(definitionCallsFor("machine-1"), 3));

  const computerSelect = screen.getAllByRole("combobox")[0];
  assert.ok(computerSelect);
  fireEvent.click(computerSelect);
  const studioOption = await screen.findByRole("option", { name: "Studio (studio.local)" });
  fireEvent.pointerDown(studioOption);
  fireEvent.click(studioOption);

  await waitFor(() => assert.equal(definitionCallsFor("machine-2"), 3));
  assert.equal(definitionCallsFor("machine-1"), 3);
  const runtimeSelect = screen.getAllByRole("combobox")[1];
  fireEvent.click(runtimeSelect);
  const builtInOption = await screen.findByRole("option", { name: "Built-in Pi" });
  fireEvent.pointerDown(builtInOption);
  fireEvent.click(builtInOption);
  assert.ok(await screen.findByText("Server DeepSeek"));
  assert.equal(screen.queryByText("Loading runtime configuration…"), null);
  assert.equal(definitionCallsFor("machine-2"), 3);
  assert.equal(definitionCallsFor("machine-1"), 3);
});

for (const mode of ["malformed", "failed", "source-failed"] as const) {
  test(`malformed or failed Built-in definition stays fail-closed: ${mode}`, async () => {
    cleanup();
    seedStores(["builtin"]);
    let postCalls = 0;
    api.get = (async (url: string) => {
      if (url === "/provider-connections") return { data: { connections: [] } } as never;
      if (url.endsWith("/runtime-options")) {
        return { data: { context: "new_agent", machineId: "machine-1", options: [runtimeOption("builtin", ref)] } } as never;
      }
      if (url.includes("/runtime-form-definitions/")) {
        if (mode === "failed") throw new Error("definition unavailable");
        if (mode === "source-failed" && url.includes("/option-sources/")) {
          throw new Error("option source unavailable");
        }
        if (mode === "source-failed") return { data: definitionResponse() } as never;
        return { data: { ...definitionResponse(), protocolVersion: 2 } } as never;
      }
      if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
      throw new Error(`unexpected GET ${url}`);
    }) as typeof api.get;
    api.post = (async (url: string) => {
      if (url === "/feature-flags/evaluate") {
        return { data: { evaluations: [] } } as never;
      }
      postCalls += 1;
      throw new Error("must not submit");
    }) as typeof api.post;

    renderDialog();
    assert.ok(await screen.findByTestId("schema-runtime-unavailable"));
    fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "Alice" } });
    const create = screen.getByRole("button", { name: "Create Agent" }) as HTMLButtonElement;
    assert.equal(create.disabled, true);
    const form = create.closest("form");
    assert.ok(form);
    fireEvent.submit(form);
    assert.equal(postCalls, 0);
  });
}

test("a no-ref Codex row skips definition fetch and submits through the legacy path", async () => {
  seedStores(["codex"]);
  const getCalls: string[] = [];
  const postBodies: unknown[] = [];
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    getCalls.push(url);
    if (url.endsWith("/runtime-options")) {
      return { data: { context: "new_agent", machineId: "machine-1", options: [runtimeOption("codex")] } } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/agents");
    postBodies.push(body);
    const request = body as { runtime: string; runtimeConfig: unknown };
    return { data: makeAgent(request.runtime, request.runtimeConfig) } as never;
  }) as typeof api.post;

  renderDialog();
  await waitFor(() => assert.ok(screen.getAllByText("Codex CLI").length > 0));
  await waitFor(() => assert.equal(getCalls.some((url) => url.includes("runtime-form-definitions")), false));
  assert.equal(screen.queryByTestId("schema-runtime-unavailable"), null);
  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "Alice" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

  await waitFor(() => assert.equal(postBodies.length, 1));
  const submitted = postBodies[0] as Record<string, unknown> & { runtimeConfig: { runtime: string } };
  assert.equal(submitted.formDefinitionRef, undefined);
  assert.equal(submitted.runtimeConfig.runtime, "codex");
});

test("managed create stays on its current surface when another agent already exists", async () => {
  seedStores(["codex"]);
  useServerStore.setState((state) => ({ current: { ...state.current!, slug: "server", plan: "pro" } }));
  useAgentStore.setState({ agents: [makeAgent("codex", { runtime: "codex" })] });
  useChannelStore.setState({
    channels: [{ id: "all-channel", name: "all" }],
  } as never);
  mockCodexCreateApi();
  let closed = false;

  renderDialog({
    initialEntry: "/s/server/channel/channel-1",
    onClose: () => { closed = true; },
  });
  await submitManagedAgent("Second");

  await waitFor(() => assert.equal(closed, true));
  assert.equal(screen.getByTestId("create-agent-location").textContent, "/s/server/channel/channel-1");
  assert.equal(useAgentStore.getState().agents.length, 2);
});

test("first managed create lands on the real all channel", async () => {
  seedStores(["codex"]);
  useServerStore.setState((state) => ({ current: { ...state.current!, slug: "server" } }));
  useChannelStore.setState({
    channels: [{ id: "all-id", name: "all" }],
  } as never);
  mockCodexCreateApi();
  let closed = false;

  renderDialog({
    initialEntry: "/s/server/channel/channel-1",
    onClose: () => { closed = true; },
  });
  await submitManagedAgent("First");

  await waitFor(() => assert.equal(closed, true));
  await waitFor(() => {
    assert.equal(screen.getByTestId("create-agent-location").textContent, "/s/server/channel/all-id");
  });
});

test("external create lands on the new agent setup route", async () => {
  seedStores(["codex"]);
  useServerStore.setState((state) => ({ current: { ...state.current!, slug: "server" } }));
  let requestBody: Record<string, unknown> | undefined;
  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/agents");
    requestBody = body as Record<string, unknown>;
    return {
      data: {
        ...makeAgent("external", null),
        id: "external-agent",
        machineId: null,
      },
    } as never;
  }) as typeof api.post;
  let closed = false;

  renderDialog({
    external: true,
    initialEntry: "/s/server/channel/channel-1",
    onClose: () => { closed = true; },
  });
  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "External" } });
  const create = screen.getByRole("button", { name: "Create External Agent" }) as HTMLButtonElement;
  await waitFor(() => assert.equal(create.disabled, false));
  fireEvent.click(create);

  await waitFor(() => assert.equal(closed, true));
  await waitFor(() => {
    assert.equal(screen.getByTestId("create-agent-location").textContent, "/s/server/agent/external-agent");
  });
  assert.equal(requestBody?.external, true);
  assert.ok(
    requestBody !== undefined && !("externalPurpose" in requestBody),
    "ordinary External Agent create must not send an externalPurpose field",
  );
});

test("agent:create ActionCard keeps a first-agent create on the card surface", async () => {
  seedStores(["codex"]);
  useServerStore.setState((state) => ({ current: { ...state.current!, slug: "server" } }));
  useChannelStore.setState({
    channels: [
      { id: "all-id", name: "all" },
      {
        id: "source-channel",
        serverId: "server-1",
        name: "source-channel",
        type: "channel",
        joined: true,
        archivedAt: null,
      },
    ],
  } as never);
  const messageId = "action-card-message";
  const channelId = "source-channel";
  const metadata = {
    kind: "action-card",
    state: "prepared",
    action: {
      type: "agent:create",
      name: "Guided",
    },
  } as const;
  useMessageStore.setState({
    currentChannelId: channelId,
    channelMessages: {
      [channelId]: [{
        id: messageId,
        channelId,
        senderType: "agent",
        senderId: "guide-agent",
        content: "",
        createdAt: "2026-08-20T00:00:00.000Z",
        actionMetadata: metadata,
      }],
    },
    messages: [{
      id: messageId,
      channelId,
      senderType: "agent",
      senderId: "guide-agent",
      content: "",
      createdAt: "2026-08-20T00:00:00.000Z",
      actionMetadata: metadata,
    }],
  } as never);
  const postCalls: string[] = [];
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    if (url.endsWith("/runtime-options")) {
      return { data: { context: "new_agent", machineId: "machine-1", options: [runtimeOption("codex")] } } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    postCalls.push(url);
    if (url === "/agents") {
      const request = body as { runtime: string; runtimeConfig: unknown };
      return { data: { ...makeAgent(request.runtime, request.runtimeConfig), id: "guided-agent" } } as never;
    }
    if (url === `/actions/${messageId}/mark-executed`) {
      return {
        data: {
          messageId,
          metadata: {
            ...metadata,
            state: "executed",
            result: { kind: "agent", id: "guided-agent", name: "Guided" },
          },
        },
      } as never;
    }
    if (url === `/actions/${messageId}/event`) return { data: {} } as never;
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;

  render(
    <MemoryRouter initialEntries={["/s/server/channel/channel-1"]}>
      <LocationProbe />
      <ActionCard
        messageId={messageId}
        channelId={channelId}
        metadata={metadata as never}
      />
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await waitFor(() => assert.ok(screen.getAllByText("Codex CLI").length > 0));
  const createButtons = screen.getAllByRole("button", { name: "Create Agent" });
  const submit = createButtons.find((button) => button.closest("form")) as HTMLButtonElement | undefined;
  assert.ok(submit);
  await waitFor(() => assert.equal(submit.disabled, false));
  fireEvent.click(submit);

  await waitFor(() => assert.ok(postCalls.includes(`/actions/${messageId}/mark-executed`)));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.ok(postCalls.includes("/agents"));
  assert.equal(screen.getByTestId("create-agent-location").textContent, "/s/server/channel/channel-1");
});

test("Built-in v3 advanced plugin checkbox defaults off and submits the user selection", async () => {
  seedStores(["builtin"]);
  const nextRef = { ...ref, schemaVersion: "builtin-pi.create.v3" };
  const definition = definitionResponse();
  Object.assign(definition, nextRef);
  definition.dataSchema.properties.loadLocalPlugins = { type: "boolean", title: "Load local Pi extensions" };
  definition.uiSchema.order.push("loadLocalPlugins");
  definition.uiSchema.layout.advanced.push("/loadLocalPlugins");
  for (const source of Object.values(definition.optionSources)) source.schemaVersion = nextRef.schemaVersion;
  const sources = definitionFixture().optionSources;
  for (const source of Object.values(sources)) source.schemaVersion = nextRef.schemaVersion;
  let submitted: { runtimeConfig: { loadLocalPlugins: boolean } } | undefined;
  api.get = (async (url: string) => {
    if (url.endsWith("/runtime-options")) return { data: { context: "new_agent", machineId: "machine-1", options: [runtimeOption("builtin", nextRef)] } } as never;
    if (url.includes("/option-sources/provider?")) return { data: sources.provider } as never;
    if (url.includes("/option-sources/model?")) return { data: sources.model } as never;
    if (url.includes("/runtime-form-definitions/builtin?")) return { data: definition } as never;
    if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (_url: string, body: unknown) => {
    if (_url !== "/agents") return { data: {} } as never;
    submitted = body as typeof submitted;
    return { data: makeAgent("builtin", submitted?.runtimeConfig) } as never;
  }) as typeof api.post;
  renderDialog();
  await screen.findByText("Server DeepSeek");
  fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
  const toggle = screen.getByRole("checkbox", { name: "Load local Pi extensions" });
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  fireEvent.click(toggle);
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "plugin-agent" } });
  fireEvent.change(screen.getByTestId("schema-runtime-api-key"), { target: { value: "test-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await waitFor(() => assert.equal(submitted?.runtimeConfig.loadLocalPlugins, true));
});

test("with runtime_form_v2_web on, create renders the v2 form by field kind, tolerates new fields, and submits field values", async () => {
  seedStores(["kimi-sdk"]);
  const postBodies: unknown[] = [];
  const served = toRuntimeFormV2(kimiDefinitionResponse() as unknown as AgentCreateFormDefinition) as unknown as {
    dataSchema: { properties: Record<string, unknown> };
    uiSchema: { localization: Record<string, unknown> };
  } & Record<string, unknown>;
  // Things a newer server may send: an unknown top-level key, a new optional
  // field of a kind this client cannot render, a new optional boolean.
  served.somethingNew = { at: "top level" };
  served.dataSchema.properties.newWidget = { type: "color", title: "Colour" };
  served.dataSchema.properties.newFlag = { type: "boolean", title: "Brand new flag" };
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    if (url.endsWith("/runtime-options")) {
      return { data: { context: "new_agent", machineId: "machine-1", options: [{ ...runtimeOption("kimi-sdk", kimiRef), runtimeFormV2: { protocolVersion: 2 } }] } } as never;
    }
    if (url === "/servers/server-1/machines/machine-1/runtime-forms/v2/kimi-sdk") return { data: served } as never;
    if (url === "/servers/server-1/machines/machine-1/runtime-forms/v2/kimi-sdk/option-sources/model") {
      return { data: kimiDefinitionFixture().optionSources.model } as never;
    }
    if (url.includes("/runtime-form-definitions/kimi-sdk/option-sources/model?schemaVersion=")) {
      return { data: kimiDefinitionFixture().optionSources.model } as never;
    }
    if (url.includes("/runtime-form-definitions/kimi-sdk?schemaVersion=")) return { data: kimiDefinitionResponse() } as never;
    if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: RUNTIME_FORM_V2_WEB_FLAG_KEY, enabled: true }] } } as never;
    }
    assert.equal(url, "/agents");
    postBodies.push(body);
    return { data: makeAgent("kimi-sdk", null) } as never;
  }) as typeof api.post;

  await prefetchServerFeatureFlags("server-1");
  renderDialog();

  const modelSelect = await screen.findByTestId("runtime-form-v2-model");
  // getBy* throws when absent: labels come from the served localization, effort
  // choices follow the selected model, and a new optional boolean renders.
  screen.getByText("Served Kimi model");
  screen.getByTestId("runtime-form-v2-reasoningEffort");
  screen.getByText("Brand new flag");
  assert.ok(screen.queryByText("Colour") === null, "an optional field of an unknown kind is skipped, not fatal");
  assert.ok(screen.queryByTestId("schema-runtime-model-select") === null, "the v1 renderer is not used");

  fireEvent.click(modelSelect);
  const k2Option = await screen.findByRole("option", { name: "Kimi K2" });
  fireEvent.pointerDown(k2Option);
  fireEvent.click(k2Option);
  await waitFor(() => assert.ok(screen.queryByTestId("runtime-form-v2-reasoningEffort") === null));

  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "V2Alice" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await waitFor(() => assert.equal(postBodies.length, 1));
  const submitted = postBodies[0] as Record<string, unknown> & { formValues: Record<string, unknown> };
  assert.deepEqual(submitted.formDefinitionRef, { protocolVersion: 2, runtimeId: "kimi-sdk" });
  assert.equal(submitted.runtimeConfig, undefined, "v2 submits field values, never a client-built runtimeConfig");
  assert.equal(submitted.formValues.model, "kimi-code/k2");
  assert.equal(submitted.formValues.reasoningEffort, null);
  assert.equal(submitted.formValues.newFlag, false);
});

// v2 create opens by the row's own `runtimeFormV2` marker, not by the v1
// `formDefinitionRef`: a runtime can have a v2 form and no v1 form at all.
async function renderV2OnlyCodexCreate(flag: boolean) {
  seedStores(["codex"]);
  const getCalls: string[] = [];
  const postBodies: unknown[] = [];
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    getCalls.push(url);
    if (url.endsWith("/runtime-options")) {
      return {
        data: { context: "new_agent", machineId: "machine-1", options: [{ ...runtimeOption("codex"), runtimeFormV2: { protocolVersion: 2 } }] },
      } as never;
    }
    if (url === "/servers/server-1/machines/machine-1/runtime-forms/v2/codex") {
      return {
        data: {
          protocolVersion: 2,
          runtimeId: "codex",
          schemaVersion: "codex.v2-test",
          dataSchema: { type: "object", required: ["model"], properties: { model: { type: "string", title: "Served codex model" } } },
        },
      } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: RUNTIME_FORM_V2_WEB_FLAG_KEY, enabled: flag }] } } as never;
    }
    assert.equal(url, "/agents");
    postBodies.push(body);
    return { data: makeAgent("codex", null) } as never;
  }) as typeof api.post;
  await prefetchServerFeatureFlags("server-1");
  renderDialog();
  await waitFor(() => assert.ok(screen.getAllByText("Codex CLI").length > 0));
  return { getCalls, postBodies };
}

test("with runtime_form_v2_web on, a runtime with only a v2 form creates through the v2 form", async () => {
  const { getCalls, postBodies } = await renderV2OnlyCodexCreate(true);
  const field = await screen.findByTestId("runtime-form-v2-model");
  screen.getByText("Served codex model");
  assert.ok(screen.queryByTestId("runtime-model-source-status") === null, "the legacy fields are replaced");
  assert.equal(getCalls.some((url) => url.includes("runtime-form-definitions")), false, "no v1 definition is fetched");
  fireEvent.change(field, { target: { value: "gpt-5.5" } });
  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "V2Codex" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await waitFor(() => assert.equal(postBodies.length, 1));
  const submitted = postBodies[0] as Record<string, unknown>;
  assert.deepEqual(submitted.formDefinitionRef, { protocolVersion: 2, runtimeId: "codex" });
  assert.deepEqual(submitted.formValues, { model: "gpt-5.5" });
  assert.equal(submitted.runtimeConfig, undefined);
});

test("with runtime_form_v2_web off, the v2 marker changes nothing: create stays on the legacy form", async () => {
  const { getCalls, postBodies } = await renderV2OnlyCodexCreate(false);
  await screen.findByTestId("runtime-model-source-status"); // the legacy Codex model field
  assert.ok(screen.queryByTestId("runtime-form-v2-model") === null);
  assert.equal(getCalls.some((url) => url.includes("/runtime-forms/") || url.includes("runtime-form-definitions")), false);
  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "Alice" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await waitFor(() => assert.equal(postBodies.length, 1));
  const submitted = postBodies[0] as Record<string, unknown> & { runtimeConfig: { runtime: string } };
  assert.equal(submitted.formDefinitionRef, undefined);
  assert.equal(submitted.runtimeConfig.runtime, "codex");
});

// requiredClientCapabilities (packages/runtime-form README, "Protocol v2"):
// absent or null → usable; an unknown capability or a malformed value → the
// whole v2 form is unavailable and create falls back to the v1 schema form.
for (const [label, requiredClientCapabilities, v2Usable] of [
  ["null", null, true],
  ["only capabilities this build implements", ["select.custom_value", "choice.labels", "option_source.status"], true],
  ["an unknown capability", ["select.custom_value", "future.capability"], false],
  ["a non-array value", "select.custom_value", false],
  ["a non-string entry", [1], false],
] as const) {
  test(`create with a v2 form whose requiredClientCapabilities is ${label} ${v2Usable ? "uses v2" : "falls back to v1"}`, async () => {
    seedStores(["kimi-sdk"]);
    const served = { ...toRuntimeFormV2(kimiDefinitionResponse() as unknown as AgentCreateFormDefinition), requiredClientCapabilities };
    api.get = (async (url: string) => {
      if (url === "/provider-connections") return { data: { connections: [] } } as never;
      if (url.endsWith("/runtime-options")) {
        return { data: { context: "new_agent", machineId: "machine-1", options: [{ ...runtimeOption("kimi-sdk", kimiRef), runtimeFormV2: { protocolVersion: 2 } }] } } as never;
      }
      if (url === "/servers/server-1/machines/machine-1/runtime-forms/v2/kimi-sdk") return { data: served } as never;
      if (url === "/servers/server-1/machines/machine-1/runtime-forms/v2/kimi-sdk/option-sources/model") {
        return { data: kimiDefinitionFixture().optionSources.model } as never;
      }
      if (url.includes("/runtime-form-definitions/kimi-sdk/option-sources/model?schemaVersion=")) {
        return { data: kimiDefinitionFixture().optionSources.model } as never;
      }
      if (url.includes("/runtime-form-definitions/kimi-sdk?schemaVersion=")) return { data: kimiDefinitionResponse() } as never;
      if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
      throw new Error(`unexpected GET ${url}`);
    }) as typeof api.get;
    api.post = (async (url: string) => {
      if (url === "/feature-flags/evaluate") {
        return { data: { evaluations: [{ key: RUNTIME_FORM_V2_WEB_FLAG_KEY, enabled: true }] } } as never;
      }
      throw new Error(`unexpected POST ${url}`);
    }) as typeof api.post;
    await prefetchServerFeatureFlags("server-1");
    renderDialog();
    if (v2Usable) {
      await screen.findByTestId("runtime-form-v2-model");
      assert.ok(screen.queryByTestId("schema-runtime-model-select") === null);
    } else {
      await screen.findByTestId("schema-runtime-model-select");
      assert.ok(screen.queryByTestId("runtime-form-v2-model") === null);
      assert.ok(screen.queryByTestId("schema-runtime-unavailable") === null, "a fallback, not an error");
    }
  });
}

// Batch 2: OpenCode has a v2 form (and no v1 form). The server's own shared
// fixtures stand in for the responses: the form and the non-live fallback
// option source (packages/runtime-form/fixtures).
const runtimeFormFixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../runtime-form/fixtures/${name}`, import.meta.url), "utf8")) as unknown;

async function renderOpenCodeCreate(flag: boolean) {
  seedStores(["opencode"]);
  const getCalls: string[] = [];
  const postBodies: unknown[] = [];
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    getCalls.push(url);
    if (url.endsWith("/runtime-options")) {
      return {
        data: { context: "new_agent", machineId: "machine-1", options: [{ ...runtimeOption("opencode"), runtimeFormV2: { protocolVersion: 2 } }] },
      } as never;
    }
    if (url === "/servers/server-1/machines/machine-1/runtime-forms/v2/opencode") return { data: runtimeFormFixture("opencode.form.json") } as never;
    if (url === "/servers/server-1/machines/machine-1/runtime-forms/v2/opencode/option-sources/model") {
      return { data: runtimeFormFixture("opencode.option-source.fallback.json") } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { kind: "missing_config" } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: RUNTIME_FORM_V2_WEB_FLAG_KEY, enabled: flag }] } } as never;
    }
    assert.equal(url, "/agents");
    postBodies.push(body);
    return { data: makeAgent("opencode", null) } as never;
  }) as typeof api.post;
  await prefetchServerFeatureFlags("server-1");
  renderDialog();
  await waitFor(() => assert.ok(screen.getAllByText("OpenCode").length > 0));
  return { getCalls, postBodies };
}

test("with runtime_form_v2_web on, OpenCode creates through its v2 form: model select plus advanced env vars", async () => {
  const { getCalls, postBodies } = await renderOpenCodeCreate(true);
  const model = await screen.findByTestId("runtime-form-v2-model");
  screen.getByText("Models available from this computer's OpenCode configuration.");
  assert.ok(screen.queryByTestId("runtime-model-source-status") === null, "the legacy fields are replaced");
  assert.equal(getCalls.some((url) => url.includes("runtime-form-definitions")), false, "no v1 definition is fetched");
  // Environment variables sit under Advanced.
  const advanced = screen.getByRole("button", { name: /Advanced/i });
  assert.equal(advanced.getAttribute("aria-expanded"), "false");
  fireEvent.click(advanced);
  assert.equal(advanced.getAttribute("aria-expanded"), "true");
  screen.getByText("These will be injected into the runtime command environment.");
  // The option source's defaultValue preselects; pick another bundled model.
  fireEvent.click(model);
  const option = await screen.findByRole("option", { name: "DeepSeek V4 Pro · DeepSeek" });
  fireEvent.pointerDown(option);
  fireEvent.click(option);
  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "V2OpenCode" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await waitFor(() => assert.equal(postBodies.length, 1));
  const submitted = postBodies[0] as Record<string, unknown>;
  assert.deepEqual(submitted.formDefinitionRef, { protocolVersion: 2, runtimeId: "opencode" });
  assert.equal((submitted.formValues as Record<string, unknown>).model, "deepseek/deepseek-v4-pro");
  assert.equal(submitted.runtimeConfig, undefined);
});

test("with runtime_form_v2_web off, OpenCode stays on the legacy form", async () => {
  const { getCalls, postBodies } = await renderOpenCodeCreate(false);
  await screen.findByTestId("runtime-model-source-status");
  assert.ok(screen.queryByTestId("runtime-form-v2-model") === null);
  assert.equal(getCalls.some((url) => url.includes("/runtime-forms/") || url.includes("runtime-form-definitions")), false);
  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "Alice" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await waitFor(() => assert.equal(postBodies.length, 1));
  const submitted = postBodies[0] as Record<string, unknown> & { runtimeConfig: { runtime: string } };
  assert.equal(submitted.formDefinitionRef, undefined);
  assert.equal(submitted.runtimeConfig.runtime, "opencode");
});

// Batch 3a: Codex/Grok v2 forms use select.custom_value, choice.labels and
// option_source.status. The server's shared fixtures stand in for the form and
// its model source (packages/runtime-form/fixtures).
async function renderCodexV2Create(sourceResponses: Array<() => unknown>, form: unknown = runtimeFormFixture("codex.form.json")) {
  seedStores(["codex"]);
  const sourceCalls: string[] = [];
  const postBodies: unknown[] = [];
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    if (url.endsWith("/runtime-options")) {
      return { data: { context: "new_agent", machineId: "machine-1", options: [{ ...runtimeOption("codex"), runtimeFormV2: { protocolVersion: 2 } }] } } as never;
    }
    if (url === "/servers/server-1/machines/machine-1/runtime-forms/v2/codex") return { data: form } as never;
    if (url.startsWith("/servers/server-1/machines/machine-1/runtime-forms/v2/codex/option-sources/model")) {
      sourceCalls.push(url);
      const respond = sourceResponses[Math.min(sourceCalls.length - 1, sourceResponses.length - 1)]!;
      return { data: respond() } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { kind: "missing_config" } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: RUNTIME_FORM_V2_WEB_FLAG_KEY, enabled: true }] } } as never;
    }
    assert.equal(url, "/agents");
    postBodies.push(body);
    return { data: makeAgent("codex", null) } as never;
  }) as typeof api.post;
  await prefetchServerFeatureFlags("server-1");
  renderDialog();
  return { sourceCalls, postBodies };
}

const pickOption = async (trigger: HTMLElement, name: RegExp | string) => {
  fireEvent.click(trigger);
  const option = await screen.findByRole("option", { name });
  fireEvent.pointerDown(option);
  fireEvent.click(option);
};

test("codex v2 create: combobox model, labelled reasoning choices, fast mode; a typed custom model is submitted as typed", async () => {
  const { sourceCalls, postBodies } = await renderCodexV2Create([() => runtimeFormFixture("codex.option-source.live.json")]);
  const model = await screen.findByTestId("runtime-form-v2-model");
  assert.ok(screen.queryByTestId("runtime-model-source-status") === null, "the legacy model field is replaced");
  assert.ok(screen.queryByTestId("runtime-form-v2-model-status") === null, "a live source has no status line");
  assert.deepEqual(sourceCalls, ["/servers/server-1/machines/machine-1/runtime-forms/v2/codex/option-sources/model"]);

  // Reasoning follows the model and is labelled from `choices`, descriptions included.
  const reasoning = screen.getByTestId("runtime-form-v2-reasoningEffort");
  fireEvent.click(reasoning);
  await screen.findByRole("option", { name: /^Extra High/ });
  screen.getByText("Balances speed and reasoning depth for everyday tasks");
  assert.ok(screen.queryByRole("option", { name: /^xhigh$/ }) === null, "raw values are not the labels");
  const ultra = screen.getByRole("option", { name: /^Ultra/ });
  fireEvent.pointerDown(ultra);
  fireEvent.click(ultra);

  // Fast mode is a switch.
  fireEvent.click(screen.getByTestId("runtime-form-v2-fastMode"));

  // Custom: pick "Custom", then type.
  await pickOption(model, "Custom");
  const typed = await screen.findByTestId("runtime-form-v2-model-custom");
  fireEvent.change(typed, { target: { value: "my-org/typed-model" } });

  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "V2Codex" } });
  const create = screen.getByRole("button", { name: "Create Agent" }) as HTMLButtonElement;
  await waitFor(() => assert.equal(create.disabled, false));
  fireEvent.click(create);
  await waitFor(() => assert.equal(postBodies.length, 1));
  const submitted = postBodies[0] as Record<string, unknown> & { formValues: Record<string, unknown> };
  assert.deepEqual(submitted.formDefinitionRef, { protocolVersion: 2, runtimeId: "codex" });
  assert.equal(submitted.runtimeConfig, undefined);
  assert.equal(submitted.formValues.model, "my-org/typed-model");
  assert.equal(submitted.formValues.fastMode, true);
  assert.equal(submitted.formValues.reasoningEffort, null, "a typed model has no effort menu: the runtime default");
});

test("codex v2 create: a source that fails to load shows status and retry without killing the form; retry sends refresh=1", async () => {
  const { sourceCalls, postBodies } = await renderCodexV2Create([
    () => { throw Object.assign(new Error("boom"), { response: { status: 500, data: { error: "boom" } } }); },
    () => runtimeFormFixture("codex.option-source.live.json"),
  ]);
  const status = await screen.findByTestId("runtime-form-v2-model-status");
  assert.equal(status.getAttribute("data-source-status"), "unavailable");
  assert.match(status.textContent ?? "", /The options could not be loaded\./);
  // The rest of the form is there: not an error panel, not the legacy form.
  screen.getByTestId("runtime-form-v2-fastMode");
  assert.ok(screen.queryByTestId("schema-runtime-unavailable") === null);
  assert.ok(screen.queryByTestId("runtime-model-source-status") === null);
  // Required + unavailable blocks submit.
  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "V2Codex" } });
  const create = screen.getByRole("button", { name: "Create Agent" }) as HTMLButtonElement;
  assert.equal(create.disabled, true);

  fireEvent.click(screen.getByTestId("runtime-form-v2-model-retry"));
  await waitFor(() => assert.ok(screen.queryByTestId("runtime-form-v2-model-status") === null));
  assert.deepEqual(sourceCalls, [
    "/servers/server-1/machines/machine-1/runtime-forms/v2/codex/option-sources/model",
    "/servers/server-1/machines/machine-1/runtime-forms/v2/codex/option-sources/model?refresh=1",
  ]);
  await waitFor(() => assert.equal(create.disabled, false));
  fireEvent.click(create);
  await waitFor(() => assert.equal(postBodies.length, 1));
  assert.equal((postBodies[0] as { formValues: Record<string, unknown> }).formValues.model, "gpt-5.6-sol");
});

test("codex v2 create: a required field whose source is unavailable shows why, offers retry and blocks submit; fallback is usable", async () => {
  await renderCodexV2Create([() => runtimeFormFixture("codex.option-source.unavailable.json")]);
  const status = await screen.findByTestId("runtime-form-v2-model-status");
  assert.equal(status.getAttribute("data-source-status"), "unavailable");
  assert.match(status.textContent ?? "", /This Computer is offline\./);
  screen.getByTestId("runtime-form-v2-model-retry");
  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "V2Codex" } });
  assert.equal((screen.getByRole("button", { name: "Create Agent" }) as HTMLButtonElement).disabled, true);
  cleanup();

  await renderCodexV2Create([() => runtimeFormFixture("codex.option-source.fallback.json")]);
  const fallback = await screen.findByTestId("runtime-form-v2-model-status");
  assert.equal(fallback.getAttribute("data-source-status"), "fallback");
  assert.match(fallback.textContent ?? "", /needs configuration on this Computer.*Showing the standard list instead\./);
  assert.ok(screen.queryByTestId("runtime-form-v2-model-retry") === null, "missing_config is not retryable");
  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "V2Codex" } });
  await waitFor(() => assert.equal((screen.getByRole("button", { name: "Create Agent" }) as HTMLButtonElement).disabled, false));
});

test("codex v2 create: an optional field whose source is unavailable is hidden", async () => {
  const form = runtimeFormFixture("codex.form.json") as { dataSchema: { required: string[] } };
  form.dataSchema.required = [];
  await renderCodexV2Create([() => runtimeFormFixture("codex.option-source.unavailable.json")], form);
  await screen.findByTestId("runtime-form-v2-fastMode");
  assert.ok(screen.queryByTestId("runtime-form-v2-model") === null);
  assert.ok(screen.queryByTestId("runtime-form-v2-model-status") === null);
});

// Batch 3b: Claude's v2 form is the first with a second (static) option source
// and fields shown only for one provider choice. Fixtures: the server's own.
async function renderClaudeV2Create() {
  seedStores(["claude"]);
  const sourceCalls: string[] = [];
  const postBodies: unknown[] = [];
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    if (url.endsWith("/runtime-options")) {
      return { data: { context: "new_agent", machineId: "machine-1", options: [{ ...runtimeOption("claude"), runtimeFormV2: { protocolVersion: 2 } }] } } as never;
    }
    if (url === "/servers/server-1/machines/machine-1/runtime-forms/v2/claude") return { data: runtimeFormFixture("claude.form.json") } as never;
    if (url === "/servers/server-1/machines/machine-1/runtime-forms/v2/claude/option-sources/provider") {
      sourceCalls.push(url);
      return { data: runtimeFormFixture("claude.option-source.provider.json") } as never;
    }
    if (url === "/servers/server-1/machines/machine-1/runtime-forms/v2/claude/option-sources/model") {
      sourceCalls.push(url);
      return { data: runtimeFormFixture("claude.option-source.fallback.json") } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { kind: "missing_config" } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: RUNTIME_FORM_V2_WEB_FLAG_KEY, enabled: true }] } } as never;
    }
    assert.equal(url, "/agents");
    postBodies.push(body);
    return { data: makeAgent("claude", null) } as never;
  }) as typeof api.post;
  await prefetchServerFeatureFlags("server-1");
  renderDialog();
  return { sourceCalls, postBodies };
}

test("claude v2 create: API URL and key appear only for a Custom provider and are submitted as field values", async () => {
  const { sourceCalls, postBodies } = await renderClaudeV2Create();
  const provider = await screen.findByTestId("runtime-form-v2-provider");
  await screen.findByTestId("runtime-form-v2-model");
  assert.deepEqual([...sourceCalls].sort(), [
    "/servers/server-1/machines/machine-1/runtime-forms/v2/claude/option-sources/model",
    "/servers/server-1/machines/machine-1/runtime-forms/v2/claude/option-sources/provider",
  ]);
  // Default provider: no API URL or key.
  assert.ok(screen.queryByTestId("runtime-form-v2-apiUrl") === null);
  assert.ok(screen.queryByTestId("runtime-form-v2-apiKey") === null);
  // The model list is the bundled fallback while the Computer is offline, with a retry.
  const status = screen.getByTestId("runtime-form-v2-model-status");
  assert.equal(status.getAttribute("data-source-status"), "fallback");
  screen.getByTestId("runtime-form-v2-model-retry");

  await pickOption(provider, "Custom");
  const apiUrl = await screen.findByTestId("runtime-form-v2-apiUrl") as HTMLInputElement;
  const apiKey = screen.getByTestId("runtime-form-v2-apiKey") as HTMLInputElement;
  assert.equal(apiKey.type, "password");
  fireEvent.change(apiUrl, { target: { value: "https://gateway.example.test" } });
  fireEvent.change(apiKey, { target: { value: "sk-typed" } });
  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "V2Claude" } });
  const create = screen.getByRole("button", { name: "Create Agent" }) as HTMLButtonElement;
  await waitFor(() => assert.equal(create.disabled, false));
  fireEvent.click(create);
  await waitFor(() => assert.equal(postBodies.length, 1));
  const submitted = postBodies[0] as Record<string, unknown> & { formValues: Record<string, unknown> };
  assert.deepEqual(submitted.formDefinitionRef, { protocolVersion: 2, runtimeId: "claude" });
  assert.equal(submitted.runtimeConfig, undefined);
  assert.equal(submitted.formValues.provider, "custom");
  assert.equal(submitted.formValues.apiUrl, "https://gateway.example.test");
  assert.equal(submitted.formValues.apiKey, "sk-typed");
  assert.equal(submitted.formValues.model, "opus");
});

// Batch 4: Pi. Two model fields, one per kind of provider: the Configured
// provider's Computer list (a combobox) and a built-in provider's own list (a
// dependent select). Pi has no saved provider connections. Fixtures: the server's own.
async function renderPiV2Create() {
  seedStores(["pi"]);
  const sourceCalls: string[] = [];
  const connectionCalls: string[] = [];
  const postBodies: unknown[] = [];
  const base = "/servers/server-1/machines/machine-1/runtime-forms/v2/pi";
  api.get = (async (url: string) => {
    if (url === "/provider-connections") {
      connectionCalls.push(url);
      return { data: { connections: [{ id: "conn-1", name: "Team DeepSeek", providerId: "deepseek", enabled: true, hasCredential: true }] } } as never;
    }
    if (url.endsWith("/runtime-options")) {
      return { data: { context: "new_agent", machineId: "machine-1", options: [{ ...runtimeOption("pi"), runtimeFormV2: { protocolVersion: 2 } }] } } as never;
    }
    if (url === base) return { data: runtimeFormFixture("pi.form.json") } as never;
    const sources: Record<string, string> = {
      [`${base}/option-sources/provider`]: "pi.option-source.provider.json",
      [`${base}/option-sources/model`]: "pi.option-source.fallback.json",
      [`${base}/option-sources/providerModel`]: "pi.option-source.provider-model.json",
    };
    if (sources[url]) {
      sourceCalls.push(url);
      return { data: runtimeFormFixture(sources[url]!) } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { kind: "missing_config" } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      // Saved provider connections are on for this server, so their absence below is Pi's own rule.
      return {
        data: {
          evaluations: [
            { key: RUNTIME_FORM_V2_WEB_FLAG_KEY, enabled: true },
            { key: PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY, enabled: true },
          ],
        },
      } as never;
    }
    assert.equal(url, "/agents");
    postBodies.push(body);
    return { data: makeAgent("pi", null) } as never;
  }) as typeof api.post;
  await prefetchServerFeatureFlags("server-1");
  renderDialog();
  return { sourceCalls, connectionCalls, postBodies, base };
}

test("pi v2 create: Configured shows the Computer's model list; DeepSeek swaps in its key and its own model list, submitted as field values", async () => {
  const { sourceCalls, connectionCalls, postBodies, base } = await renderPiV2Create();
  const provider = await screen.findByTestId("runtime-form-v2-provider");
  await screen.findByTestId("runtime-form-v2-model");
  assert.deepEqual([...sourceCalls].sort(), [
    `${base}/option-sources/model`,
    `${base}/option-sources/provider`,
    `${base}/option-sources/providerModel`,
  ]);
  // Configured: no key; the Computer's list is the bundled fallback (missing config), no retry.
  assert.ok(screen.queryByTestId("runtime-form-v2-apiKey") === null);
  assert.ok(screen.queryByTestId("runtime-form-v2-providerModel") === null);
  assert.equal(screen.getByTestId("runtime-form-v2-model-status").getAttribute("data-source-status"), "fallback");
  assert.ok(screen.queryByTestId("runtime-form-v2-model-retry") === null);
  screen.getByTestId("runtime-form-v2-reasoningEffort");

  await pickOption(provider, "DeepSeek");
  const apiKey = await screen.findByTestId("runtime-form-v2-apiKey") as HTMLInputElement;
  assert.equal(apiKey.type, "password");
  const providerModel = screen.getByTestId("runtime-form-v2-providerModel");
  assert.ok(screen.queryByTestId("runtime-form-v2-model") === null, "the Configured model field is gone");
  assert.ok(screen.queryByTestId("runtime-form-v2-reasoningEffort") === null);
  screen.getByTestId("runtime-form-v2-providerReasoningEffort");
  assert.ok(screen.queryByTestId("runtime-form-v2-providerModel-status") === null, "a static list has no status line");
  // The provider's own list, no Custom (legacy locks the picker to it).
  fireEvent.click(providerModel);
  await screen.findByRole("option", { name: "DeepSeek V4.1 Flash" });
  assert.ok(screen.queryByRole("option", { name: "Custom" }) === null);
  const flash = screen.getByRole("option", { name: "DeepSeek V4.1 Flash" });
  fireEvent.pointerDown(flash);
  fireEvent.click(flash);

  fireEvent.change(apiKey, { target: { value: "sk-typed" } });
  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "V2Pi" } });
  const create = screen.getByRole("button", { name: "Create Agent" }) as HTMLButtonElement;
  await waitFor(() => assert.equal(create.disabled, false));
  fireEvent.click(create);
  await waitFor(() => assert.equal(postBodies.length, 1));
  const submitted = postBodies[0] as Record<string, unknown> & { formValues: Record<string, unknown> };
  assert.deepEqual(submitted.formDefinitionRef, { protocolVersion: 2, runtimeId: "pi" });
  assert.equal(submitted.runtimeConfig, undefined);
  assert.deepEqual(submitted.formValues, {
    provider: "deepseek",
    apiKey: "sk-typed",
    providerModel: "deepseek/deepseek-flash",
    providerReasoningEffort: null,
    envVars: {},
  });
  // Pi has no saved provider connections: the dialog never loads them, and the
  // provider list is Configured plus the built-in providers only.
  assert.deepEqual(connectionCalls, []);
  assert.ok(screen.queryByText(/Team DeepSeek/) === null);
});

test("pi v2 create: a typed Configured model is submitted as typed and hides the reasoning effort", async () => {
  const { postBodies } = await renderPiV2Create();
  const model = await screen.findByTestId("runtime-form-v2-model");
  await pickOption(model, "Custom");
  const typed = await screen.findByTestId("runtime-form-v2-model-custom");
  fireEvent.change(typed, { target: { value: "anthropic/claude-typed" } });
  await waitFor(() => assert.ok(screen.queryByTestId("runtime-form-v2-reasoningEffort") === null));
  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "V2PiTyped" } });
  const create = screen.getByRole("button", { name: "Create Agent" }) as HTMLButtonElement;
  await waitFor(() => assert.equal(create.disabled, false));
  fireEvent.click(create);
  await waitFor(() => assert.equal(postBodies.length, 1));
  assert.deepEqual((postBodies[0] as { formValues: Record<string, unknown> }).formValues, {
    provider: "configured", model: "anthropic/claude-typed", reasoningEffort: null, envVars: {},
  });
});
