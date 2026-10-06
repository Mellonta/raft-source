import "./helpers/domSetup";

import assert from "node:assert/strict";
import { assertOptionFieldLabels } from "./helpers/optionFieldLabels";

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AGENT_MIGRATION_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import api from "../src/api/client";
import { REGISTERED_SERVER_FEATURE_FLAG_KEYS } from "../src/store/serverFeatureFlags";
import AgentDetailPanel from "../src/components/agent/AgentDetailPanel";
import type { Locale } from "../src/i18n/locale";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";
import {
  LocationProbe,
  makeAgent,
  renderPanel,
  resetAgentDetailPanelState,
  seedPanelState,
  stubAgentDetailApi,
  stubMigrationFeatureFlag,
} from "./helpers/agentDetailPanelHarness";

afterEach(resetAgentDetailPanelState);

test("agent reminders do not refetch when only the locale changes", async () => {
  const agent = seedPanelState("server-reminder-locale");
  stubAgentDetailApi();
  const fallbackGet = api.get;
  let reminderRequests = 0;
  api.get = async (url: string, ...args: unknown[]) => {
    if (url === "/reminders") {
      reminderRequests += 1;
    }
    return fallbackGet(url, ...args);
  };
  stubMigrationFeatureFlag("server-reminder-locale");

  function PanelWithLocale({ locale }: { locale: Locale }) {
    return (
      <TestIntlProvider locale={locale}>
        <MemoryRouter initialEntries={["/s/botiverse/agent/agent-1"]}>
          <AgentDetailPanel agent={agent} />
          <LocationProbe />
        </MemoryRouter>
      </TestIntlProvider>
    );
  }

  const view = render(<PanelWithLocale locale="en" />);

  await waitFor(() => assert.equal(reminderRequests, 1));

  view.rerender(<PanelWithLocale locale="zh-cn" />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(reminderRequests, 1);
});

test("agent detail header renders Direct message as an icon-only accessible action", async () => {
  const agent = seedPanelState("server-icon-action");
  stubAgentDetailApi();
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: false }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  const messagesAction = await screen.findByTestId("agent-profile-inline-message");
  assert.equal(messagesAction.getAttribute("aria-label"), "Direct Message");
  assert.equal(messagesAction.textContent, "", "the header action must not render a visible text label");
  assert.ok(messagesAction.querySelector("svg"), "the header action keeps the MessageSquare icon");
});

test("official identity update sits under the profile name and requires a field-level confirmation", async () => {
  const agent = seedPanelState("server-official-identity", makeAgent({
    serverId: "server-official-identity",
    displayName: "Cindy-a",
    description: "Onboarding Assistant",
  }));
  useServerStore.setState((state) => ({
    current: state.current ? { ...state.current, onboardingAgentId: agent.id } : null,
  }));

  const preview = {
    canAdopt: true,
    changes: [
      { field: "displayName" as const, label: "Display name", before: "Cindy-a", after: "Cindy" },
      { field: "role" as const, label: "Description", before: "Onboarding Assistant", after: "Onboarding guide" },
    ],
    currentIdentity: {
      name: "migration-agent",
      displayName: "Cindy-a",
      role: "Onboarding Assistant",
      serverRole: "member",
      avatarUrl: null,
    },
    officialIdentity: {
      name: "migration-agent",
      displayName: "Cindy",
      role: "Onboarding guide",
      serverRole: "member",
      avatarUrl: null,
    },
  };
  stubAgentDetailApi();
  const fallbackGet = api.get;
  api.get = async (url: string) => {
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } } as never;
    if (url === "/agents/agent-1/onboarding-identity-adoption") {
      return { data: preview } as never;
    }
    return fallbackGet(url);
  };
  let adoptionCalls = 0;
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: false }] } } as never;
    }
    if (url === "/agents/agent-1/onboarding-identity-adoption") {
      adoptionCalls += 1;
      return {
        data: {
          ...preview,
          canAdopt: false,
          changes: [],
          appliedChanges: preview.changes,
          agent: { ...agent, displayName: "Cindy", description: "Onboarding guide" },
        },
      } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  // The display name is edited on the profile header, so there is no separate
  // "Display name" field; the update action sits right under the header, before
  // the Description section.
  assert.ok(screen.queryByText("Display name") === null, "the duplicate Display name field is gone");
  const updateAction = await screen.findByRole("button", { name: "Update official identity" });
  const descriptionLabel = screen.getByText("Description");
  assert.ok(
    updateAction.compareDocumentPosition(descriptionLabel) & Node.DOCUMENT_POSITION_FOLLOWING,
    "the update action renders above the Description section",
  );
  assert.ok(screen.queryByText("Official identity") === null, "identity adoption no longer creates a standalone profile section");
  assert.equal(document.body.textContent?.includes("Cindy-a -> Cindy"), false, "field changes stay out of the profile until confirmation opens");

  fireEvent.click(updateAction);

  await screen.findByRole("heading", { name: "Update official identity" });
  screen.getByText("Review official identity changes");
  const displayNameChange = document.querySelector<HTMLElement>('[data-onboarding-identity-change="displayName"]');
  const roleChange = document.querySelector<HTMLElement>('[data-onboarding-identity-change="role"]');
  assert.ok(displayNameChange);
  assert.ok(roleChange);
  assert.equal(displayNameChange.querySelector("dt")?.textContent, "Display name");
  within(displayNameChange).getByText("Cindy-a");
  within(displayNameChange).getByText("Cindy");
  assert.equal(roleChange.querySelector("dt")?.textContent, "Description");
  within(roleChange).getByText("Onboarding Assistant");
  within(roleChange).getByText("Onboarding guide");
  assert.equal(adoptionCalls, 0, "opening the field-level preview must not apply identity changes");

  fireEvent.click(screen.getByRole("button", { name: "Update identity" }));
  await waitFor(() => assert.equal(adoptionCalls, 1, "the update is sent only after explicit confirmation"));
});

test("agent detail keeps current deprecated runtime visible with warning", async () => {
  const agent = seedPanelState("server-legacy-runtime", makeAgent({
    serverId: "server-legacy-runtime",
    runtime: "antigravity",
    model: "default",
    runtimeConfig: {
      version: 1,
      runtime: "antigravity",
      model: { kind: "preset", id: "default" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
  }));
  stubAgentDetailApi();
  api.post = async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      assert.deepEqual(body, {
        serverId: "server-legacy-runtime",
        platform: "web",
        keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
      });
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: false }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  assert.ok(screen.getByText("Antigravity CLI (deprecated)"));
  assert.ok(screen.getByText("This agent uses a deprecated runtime. It can keep running, but new agents cannot select this runtime."));

  fireEvent.click(screen.getByRole("button", { name: "Edit runtime config" }));

  assert.ok(await screen.findByRole("heading", { name: "Edit runtime config" }));
  assert.ok(screen.getByText("Antigravity CLI (deprecated) (not installed)"));
});

test("flag-off current Grok stays editable only while its Computer capability is available", async () => {
  const agent = seedPanelState("server-grok-grandfathered", makeAgent({
    serverId: "server-grok-grandfathered",
    runtime: "grok",
    model: "grok-4.5",
    runtimeConfig: {
      version: 1,
      runtime: "grok",
      model: { kind: "preset", id: "grok-4.5" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
  }));
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => machine.id === "source-machine"
      ? { ...machine, runtimes: ["grok"] }
      : machine),
  }));
  stubAgentDetailApi(null, {
    kind: "live",
    value: {
      models: [
        { id: "grok-4.5", label: "Grok 4.5" },
        { id: "grok-composer-2.5-fast", label: "Composer 2.5" },
      ],
      default: "grok-4.5",
    },
  });
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: false }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);
  fireEvent.click(screen.getByRole("button", { name: "Edit runtime config" }));

  const modelSelect = await waitFor(() => {
    const select = screen.getAllByRole("combobox")
      .find((candidate) => candidate.textContent?.includes("Grok 4.5"));
    assert.ok(select);
    return select;
  });
  fireEvent.click(modelSelect);
  const composerOption = await screen.findByRole("option", { name: "Composer 2.5" });
  fireEvent.pointerDown(composerOption);
  fireEvent.click(composerOption);

  const saveButton = screen.getByRole("button", { name: "Save runtime config" });
  await waitFor(() => assert.equal((saveButton as HTMLButtonElement).disabled, false));

  act(() => useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => machine.id === "source-machine"
      ? { ...machine, runtimes: [] }
      : machine),
  })));
  await waitFor(() => assert.equal((saveButton as HTMLButtonElement).disabled, true));
});

test("Claude runtime editor renders the canonical model list and persists an exact preset", async () => {
  const agent = seedPanelState("server-claude-opus-5", makeAgent({
    serverId: "server-claude-opus-5",
    runtime: "claude",
    model: "claude-opus-4-8",
    runtimeConfig: {
      version: 1,
      runtime: "claude",
      provider: { kind: "default" },
      model: { kind: "preset", id: "claude-opus-4-8" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
  }));
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => machine.id === "source-machine"
      ? { ...machine, runtimes: ["claude"] }
      : machine),
  }));
  stubAgentDetailApi();
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: false }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };
  const patches: Array<Record<string, unknown>> = [];
  api.patch = async (url: string, body?: unknown) => {
    assert.equal(url, "/agents/agent-1");
    const patch = body as Record<string, unknown>;
    patches.push(patch);
    return { data: { ...agent, ...patch } } as never;
  };

  renderPanel(agent);
  fireEvent.click(screen.getByRole("button", { name: "Edit runtime config" }));

  const modelSelect = await waitFor(() => {
    const select = screen.getAllByRole("combobox")
      .find((candidate) => candidate.textContent?.includes("Claude Opus 4.8"));
    assert.ok(select);
    return select;
  });
  fireEvent.click(modelSelect);
  expect(
    screen.getAllByRole("option").map((option) => option.textContent?.trim() ?? ""),
  ).toMatchSnapshot();
  const opus5Option = await screen.findByRole("option", { name: "Claude Opus 5" });
  fireEvent.pointerDown(opus5Option);
  fireEvent.click(opus5Option);
  await waitFor(() => assert.match(modelSelect.textContent ?? "", /Claude Opus 5/));

  const saveButton = screen.getByRole("button", { name: "Save runtime config" }) as HTMLButtonElement;
  await waitFor(() => assert.equal(saveButton.disabled, false));
  fireEvent.click(saveButton);

  await waitFor(() => assert.equal(patches.length, 1));
  assert.equal(patches[0]?.model, "claude-opus-5");
  assert.deepEqual((patches[0]?.runtimeConfig as { model: unknown }).model, {
    kind: "preset",
    id: "claude-opus-5",
  });
});

test("Built-in edit can change model while omitting the redacted provider secret", async () => {
  const runtimeConfig = {
    version: 1 as const,
    runtime: "builtin" as const,
    provider: { kind: "preset" as const, providerId: "deepseek" as const, apiKey: "" },
    model: { kind: "preset" as const, id: "deepseek/deepseek-v4-pro" },
    mode: { kind: "default" as const },
    reasoningEffort: null,
    envVars: null,
    hostUserState: "forbidden" as const,
  };
  const agent = seedPanelState("server-builtin-secret-retain", makeAgent({
    serverId: "server-builtin-secret-retain",
    runtime: "builtin",
    model: "deepseek/deepseek-v4-pro",
    runtimeConfig,
  }));
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => machine.id === "source-machine"
      ? { ...machine, runtimes: ["builtin"] }
      : machine),
  }));
  api.get = async (url: string) => {
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } } as never;
    if (url === "/agents/agent-1/runtime-options") {
      return {
        data: {
          context: "existing_agent",
          machineId: "source-machine",
          options: [{
            runtimeId: "builtin",
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
    if (url === "/servers/server-builtin-secret-retain/machines/source-machine/runtime-models/builtin") {
      return {
        data: {
          kind: "live",
          value: {
            models: [
              { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
              { id: "deepseek/deepseek-flash", label: "DeepSeek V4.1 Flash" },
            ],
            default: "deepseek/deepseek-v4-pro",
            catalog: {
              protocolVersion: 1,
              runtime: "builtin",
              runtimeVersion: "0.84.3",
            },
          },
        },
      } as never;
    }
    if (url === "/agents/agent-1/migration") return { data: { migration: null } } as never;
    return { data: { reminders: [] } } as never;
  };
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: false }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };
  const patches: unknown[] = [];
  api.patch = async (url: string, body?: unknown) => {
    assert.equal(url, "/agents/agent-1");
    patches.push(body);
    return { data: { ...agent, ...(body as Record<string, unknown>), runtimeConfig } } as never;
  };

  renderPanel(agent);
  fireEvent.click(screen.getByRole("button", { name: "Edit runtime config" }));

  const modelSelect = await waitFor(() => {
    const select = screen.getAllByRole("combobox")
      .find((candidate) => candidate.textContent?.includes("DeepSeek V4 Pro"));
    assert.ok(select);
    return select;
  });
  fireEvent.click(modelSelect);
  const nextModel = await screen.findByRole("option", { name: "DeepSeek V4.1 Flash" });
  fireEvent.pointerDown(nextModel);
  fireEvent.click(nextModel);

  const saveButton = screen.getByRole("button", { name: "Save runtime config" }) as HTMLButtonElement;
  await waitFor(() => assert.equal(saveButton.disabled, false));
  fireEvent.click(saveButton);

  await waitFor(() => assert.equal(patches.length, 1));
  const patchBody = patches[0] as {
    runtimeConfig: { provider: Record<string, unknown>; model: unknown };
  };
  assert.deepEqual(patchBody.runtimeConfig.provider, { kind: "preset", providerId: "deepseek" });
  assert.deepEqual(patchBody.runtimeConfig.model, { kind: "preset", id: "deepseek/deepseek-flash" });
});

test("Persisted Built-in model omitted from catalog remains selectable and shows an explicit unavailable warning", async () => {
  const runtimeConfig = {
    version: 1 as const,
    runtime: "builtin" as const,
    provider: { kind: "preset" as const, providerId: "deepseek" as const, apiKey: "" },
    model: { kind: "preset" as const, id: "deepseek/deepseek-v4-flash" },
    mode: { kind: "default" as const },
    reasoningEffort: null,
    envVars: null,
    hostUserState: "forbidden" as const,
  };
  const agent = seedPanelState("server-builtin-persisted-legacy", makeAgent({
    serverId: "server-builtin-persisted-legacy",
    runtime: "builtin",
    model: "deepseek/deepseek-v4-flash",
    runtimeConfig,
  }));
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => machine.id === "source-machine"
      ? { ...machine, runtimes: ["builtin"] }
      : machine),
  }));
  api.get = async (url: string) => {
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } } as never;
    if (url === "/agents/agent-1/runtime-options") {
      return {
        data: {
          context: "existing_agent",
          machineId: "source-machine",
          options: [{
            runtimeId: "builtin",
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
    if (url === "/servers/server-builtin-persisted-legacy/machines/source-machine/runtime-models/builtin") {
      return {
        data: {
          kind: "live",
          value: {
            models: [
              { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
              { id: "deepseek/deepseek-flash", label: "DeepSeek V4.1 Flash" },
            ],
            default: "deepseek/deepseek-v4-pro",
            catalog: {
              protocolVersion: 1,
              runtime: "builtin",
              runtimeVersion: "0.84.3",
            },
          },
        },
      } as never;
    }
    if (url === "/agents/agent-1/migration") return { data: { migration: null } } as never;
    return { data: { reminders: [] } } as never;
  };
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: false }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);
  fireEvent.click(screen.getByRole("button", { name: "Edit runtime config" }));

  // The persisted model is not in the live catalog, but is preserved in the combobox options
  const modelSelect = await waitFor(() => {
    const select = screen.getAllByRole("combobox")
      .find((candidate) => candidate.textContent?.includes("deepseek/deepseek-v4-flash") || candidate.textContent?.includes("DeepSeek"));
    assert.ok(select);
    return select;
  });

  // Verify explicit unavailable status warning is displayed
  const statusWarning = await screen.findByTestId("runtime-model-source-status");
  assert.match(
    statusWarning.textContent || "",
    /This Computer's catalog does not list this model\. You can still select it; compatibility will be checked when the agent starts\./,
  );

  // Clicking the select still exposes the persisted option
  fireEvent.click(modelSelect);
  const persistedOption = await screen.findByRole("option", { name: /deepseek-v4-flash|DeepSeek/i });
  assert.ok(persistedOption);
});

test("Built-in gateway edit retains an omitted secret only while the canonical Base URL is unchanged", async () => {
  const gatewayBaseUrl = "https://gateway.example.test/v1";
  const runtimeConfig = {
    version: 1 as const,
    runtime: "builtin" as const,
    provider: {
      kind: "gateway" as const,
      providerId: "openai-compatible" as const,
      baseUrl: gatewayBaseUrl,
      apiKey: "",
    },
    model: { kind: "custom" as const, name: "acme/custom" },
    mode: { kind: "default" as const },
    reasoningEffort: null,
    envVars: null,
    hostUserState: "forbidden" as const,
  };
  const agent = seedPanelState("server-builtin-gateway-secret", makeAgent({
    serverId: "server-builtin-gateway-secret",
    runtime: "builtin",
    model: "acme/custom",
    runtimeConfig,
  }));
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => machine.id === "source-machine"
      ? { ...machine, runtimes: ["builtin"] }
      : machine),
  }));
  api.get = async (url: string) => {
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } } as never;
    if (url === "/agents/agent-1/runtime-options") {
      return {
        data: {
          context: "existing_agent",
          machineId: "source-machine",
          options: [{
            runtimeId: "builtin",
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
    if (url === "/servers/server-builtin-gateway-secret/machines/source-machine/runtime-models/builtin") {
      return { data: { models: [], default: "" } } as never;
    }
    if (url === "/agents/agent-1/migration") return { data: { migration: null } } as never;
    return { data: { reminders: [] } } as never;
  };
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: false }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };
  const patches: Array<Record<string, unknown>> = [];
  api.patch = async (url: string, body?: unknown) => {
    assert.equal(url, "/agents/agent-1");
    const patch = body as Record<string, unknown>;
    patches.push(patch);
    const patchedRuntimeConfig = patch.runtimeConfig as {
      provider: Record<string, unknown>;
      model: unknown;
    };
    return {
      data: {
        ...agent,
        ...patch,
        runtimeConfig: {
          ...patchedRuntimeConfig,
          provider: { ...patchedRuntimeConfig.provider, apiKey: "" },
        },
      },
    } as never;
  };

  renderPanel(agent);
  fireEvent.click(screen.getByRole("button", { name: "Edit runtime config" }));

  const modelInput = await screen.findByPlaceholderText("Gateway model ID") as HTMLInputElement;
  fireEvent.change(modelInput, { target: { value: "acme/next" } });
  const saveButton = screen.getByRole("button", { name: "Save runtime config" }) as HTMLButtonElement;
  await waitFor(() => assert.equal(saveButton.disabled, false));
  fireEvent.click(saveButton);

  await waitFor(() => assert.equal(patches.length, 1));
  const firstRuntimeConfig = patches[0]?.runtimeConfig as {
    provider: Record<string, unknown>;
    model: unknown;
  };
  assert.deepEqual(firstRuntimeConfig.provider, {
    kind: "gateway",
    providerId: "openai-compatible",
    baseUrl: gatewayBaseUrl,
    supportsImageInput: false,
  });
  assert.deepEqual(firstRuntimeConfig.model, { kind: "custom", name: "acme/next" });

  await waitFor(() => assert.ok(screen.queryByRole("heading", { name: "Edit runtime config" }) === null));
  fireEvent.click(screen.getByRole("button", { name: "Edit runtime config" }));
  const baseUrlInput = await screen.findByPlaceholderText("https://gateway.example.com/v1") as HTMLInputElement;
  fireEvent.change(baseUrlInput, { target: { value: "https://attacker.example.test/v1" } });
  // See the schema dialog test: raft-ui's Checkbox exposes state via aria-checked.
  const imageInput = screen.getByTestId("runtime-supports-image-input");

  // Announced by its OPTION name, not the field's group label — see the schema
  // dialog test. Asserted at the real callsite because a hand-built copy of this
  // shape stayed green through the bug.
  const imageInputName = (imageInput.getAttribute("aria-labelledby") ?? "")
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
    .filter(Boolean)
    .join(" ");
  assert.equal(imageInputName, "Supports image input",
    `a screen reader must hear the option name; it heard "${imageInputName}"`);

  // Group label vs option name — see the schema dialog test. This gateway
  // callsite regressed the same way and for the same reason.
  assertOptionFieldLabels(imageInput, {
    groupLabel: "Image input",
    optionName: "Supports image input",
  });

  // The option's name lives on the card's own title again, and the card renders
  // as a <label>, so the whole option is the hit target — no `for` needed, and
  // the field declines adoption because its content is a Card rather than one
  // control. What changed versus the original is the chrome: `variant="option"`
  // puts it at control elevation with a field-scale title.
  const optionTitle = document.getElementById("gateway-image-input-title");
  assert.ok(optionTitle, "the option must carry its own title");
  assert.equal(
    (optionTitle.textContent ?? "").trim(),
    "Supports image input",
    "the option title is what names the control",
  );
  assert.ok(
    optionTitle.closest('[data-slot="card"]'),
    "the option must be a Card — that is what makes the whole row clickable and gives it the option chrome",
  );
  assert.equal(imageInput.getAttribute("aria-checked"), "false");
  fireEvent.click(imageInput);
  assert.equal(imageInput.getAttribute("aria-checked"), "true");
  const changedUrlSaveButton = screen.getByRole("button", { name: "Save runtime config" }) as HTMLButtonElement;
  await waitFor(() => assert.equal(changedUrlSaveButton.disabled, true));

  const apiKeyInput = screen.getByPlaceholderText("sk-...") as HTMLInputElement;
  fireEvent.change(apiKeyInput, { target: { value: "replacement-secret" } });
  await waitFor(() => assert.equal(changedUrlSaveButton.disabled, false));
  fireEvent.click(changedUrlSaveButton);

  await waitFor(() => assert.equal(patches.length, 2));
  const secondRuntimeConfig = patches[1]?.runtimeConfig as {
    provider: Record<string, unknown>;
  };
  assert.deepEqual(secondRuntimeConfig.provider, {
    kind: "gateway",
    providerId: "openai-compatible",
    baseUrl: "https://attacker.example.test/v1",
    apiKey: "replacement-secret",
    supportsImageInput: true,
  });
});


test("Antigravity edit can save unrelated config while its model source stays unsupported", async () => {
  const agent = seedPanelState("server-antigravity", makeAgent({
    serverId: "server-antigravity",
    runtime: "antigravity",
    model: "default",
    status: "offline",
    executionMode: "byoc",
  }));
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => machine.id === "source-machine"
      ? { ...machine, runtimes: ["antigravity"] }
      : machine),
  }));
  stubAgentDetailApi(null, { kind: "unsupported" });
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: false }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };
  let patchBody: { runtime?: string; runtimeConfig?: { envVars?: Record<string, string> | null } } | null = null;
  api.patch = async (url: string, body?: unknown) => {
    assert.equal(url, "/agents/agent-1");
    patchBody = body as typeof patchBody;
    return { data: { ...agent, ...(body as object) } } as never;
  };

  renderPanel(agent);
  fireEvent.click(await screen.findByRole("button", { name: "Edit runtime config" }));
  // One disclosure now (@cindyz, 2026-09-03): Command and env vars sit directly
  // inside More, so there is no second "Advanced" to open.
  fireEvent.click(await screen.findByRole("button", { name: "More" }));
  fireEvent.click(await screen.findByRole("button", { name: "Add Variable" }));
  fireEvent.change(screen.getByPlaceholderText("KEY"), { target: { value: "TEAM_FLAG" } });
  fireEvent.change(screen.getByPlaceholderText("value"), { target: { value: "1" } });

  const saveButton = screen.getByRole("button", { name: "Save runtime config" });
  await waitFor(() => assert.equal((saveButton as HTMLButtonElement).disabled, false));
  fireEvent.click(saveButton);

  await waitFor(() => assert.deepEqual(patchBody && {
    runtime: patchBody.runtime,
    envVars: patchBody.runtimeConfig?.envVars,
  }, { runtime: "antigravity", envVars: { TEAM_FLAG: "1" } }));
});

test("agent profile does not flash a raw dynamic model ID before the configured label loads", async () => {
  const agent = seedPanelState("server-kimi-label", makeAgent({
    serverId: "server-kimi-label",
    runtime: "kimi-sdk",
    model: "kimi-code/k3-256k",
    runtimeConfig: {
      version: 1,
      runtime: "kimi-sdk",
      model: { kind: "custom", name: "kimi-code/k3-256k" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
    status: "offline",
    executionMode: "byoc",
  }));
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => machine.id === "source-machine"
      ? { ...machine, runtimes: ["kimi-sdk"] }
      : machine),
  }));
  stubAgentDetailApi();
  const fallbackGet = api.get;
  let resolveModels!: (value: { data: unknown }) => void;
  api.get = async (url: string, ...args: unknown[]) => {
    if (url.includes("/runtime-models/kimi-sdk")) {
      return new Promise((resolve) => {
        resolveModels = resolve;
      }) as never;
    }
    return fallbackGet(url, ...args);
  };
  stubMigrationFeatureFlag("server-kimi-label");

  renderPanel(agent);

  const rawModelIdWasVisible = screen.queryByText("kimi-code/k3-256k") !== null;
  assert.ok(screen.getByText("Loading…"), "the profile must defer to the same pending catalog authority as mention hover");

  await act(async () => {
    resolveModels({
      data: {
        kind: "live",
        value: {
          models: [{ id: "kimi-code/k3-256k", label: "K3-256k", verified: "launchable" }],
          default: "kimi-code/k3",
        },
      },
    });
  });

  assert.ok(await screen.findByText("K3-256k"));
  assert.equal(rawModelIdWasVisible, false);
  assert.ok(screen.queryByText("kimi-code/k3-256k") === null);
});

test("retryable model error offers persisted Kimi as unverified without inventing an auth failure", async () => {
  const agent = seedPanelState("server-kimi-error", makeAgent({
    serverId: "server-kimi-error",
    runtime: "kimi-sdk",
    model: "kimi-code/kimi-for-coding",
    status: "offline",
    executionMode: "byoc",
  }));
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => machine.id === "source-machine"
      ? { ...machine, runtimes: ["kimi-sdk"] }
      : machine),
  }));
  let modelChecks = 0;
  api.get = async (url: string) => {
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } } as never;
    if (url.includes("/runtime-models/kimi-sdk")) {
      modelChecks += 1;
      return { data: { kind: "error", retryable: true } } as never;
    }
    if (url === "/agents/agent-1/migration") {
      return { data: { migration: null } } as never;
    }
    return { data: { reminders: [] } } as never;
  };
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: false }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };
  let patchAttempts = 0;
  api.patch = async () => {
    patchAttempts += 1;
    return { data: agent } as never;
  };

  renderPanel(agent, "zh-cn");
  fireEvent.click(await screen.findByRole("button", { name: "编辑运行时配置" }));

  assert.ok(await screen.findByText("无法从此 Computer 加载模型。"));
  assert.equal(screen.queryByText(/Kimi is not signed in/) === null, true);
  assert.ok(screen.getByText(/尚未验证/));
  const modelSelect = screen.getAllByRole("combobox")[1];
  assert.ok(modelSelect);
  fireEvent.click(modelSelect);
  const option = screen.getByRole("option", { name: /Kimi for Coding/ });
  fireEvent.pointerDown(option);
  fireEvent.click(option);

  const saveButton = screen.getByRole("button", { name: "保存运行时配置" });
  assert.equal((saveButton as HTMLButtonElement).disabled, true);
  assert.equal(patchAttempts, 0);

  const checksBeforeRetry = modelChecks;
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => assert.equal(modelChecks, checksBeforeRetry + 1));
  assert.equal(patchAttempts, 0);
});

test("Cursor probe error permits editing with persisted Auto labeled unverified", async () => {
  const agent = seedPanelState("server-cursor-error", makeAgent({
    serverId: "server-cursor-error",
    runtime: "cursor",
    model: "auto",
    runtimeConfig: {
      version: 1,
      runtime: "cursor",
      model: { kind: "preset", id: "auto" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
    status: "offline",
    executionMode: "byoc",
  }));
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => machine.id === "source-machine"
      ? { ...machine, runtimes: ["cursor"] }
      : machine),
  }));
  stubAgentDetailApi(null, { kind: "error", retryable: true });
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: false }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };
  let patchAttempts = 0;
  api.patch = async () => {
    patchAttempts += 1;
    return { data: agent } as never;
  };

  renderPanel(agent);
  fireEvent.click(await screen.findByRole("button", { name: "Edit runtime config" }));

  assert.ok(await screen.findByText("Could not load models from this Computer."));
  const modelSelect = screen.getAllByRole("combobox")[1];
  assert.ok(modelSelect);
  assert.ok(screen.getByText(/not been verified/));
  fireEvent.click(modelSelect);
  const option = screen.getByRole("option", { name: "Auto" });
  fireEvent.pointerDown(option);
  fireEvent.click(option);

  // One disclosure now (@cindyz, 2026-09-03): Command and env vars sit directly
  // inside More, so there is no second "Advanced" to open.
  fireEvent.click(await screen.findByRole("button", { name: "More" }));
  fireEvent.click(await screen.findByRole("button", { name: "Add Variable" }));
  fireEvent.change(screen.getByPlaceholderText("KEY"), { target: { value: "TEAM_FLAG" } });
  fireEvent.change(screen.getByPlaceholderText("value"), { target: { value: "1" } });

  const saveButton = screen.getByRole("button", { name: "Save runtime config" });
  assert.equal((saveButton as HTMLButtonElement).disabled, false);
  fireEvent.click(saveButton);
  await waitFor(() => assert.equal(patchAttempts, 1));
});

test("live catalog shrink preserves the persisted edit model as unverified", async () => {
  const agent = seedPanelState("server-kimi-live-shrink", makeAgent({
    serverId: "server-kimi-live-shrink",
    runtime: "kimi-sdk",
    model: "kimi-code/kimi-for-coding",
    status: "offline",
    executionMode: "byoc",
  }));
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => machine.id === "source-machine"
      ? { ...machine, runtimes: ["kimi-sdk"] }
      : machine),
  }));
  let modelChecks = 0;
  api.get = async (url: string) => {
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } } as never;
    if (url.includes("/runtime-models/kimi-sdk")) {
      modelChecks += 1;
      return {
        data: {
          kind: "live",
          value: {
            models: [{ id: "kimi-code/new-model", label: "Kimi New Model", verified: "launchable" }],
            default: "kimi-code/new-model",
          },
        },
      } as never;
    }
    if (url === "/agents/agent-1/migration") {
      return { data: { migration: null } } as never;
    }
    return { data: { reminders: [] } } as never;
  };
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: false }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);
  fireEvent.click(await screen.findByRole("button", { name: "Edit runtime config" }));
  await waitFor(() => assert.equal(modelChecks, 1));

  const modelSelect = screen.getAllByRole("combobox")[1];
  assert.ok(modelSelect, "edit must expose the live model catalog");
  fireEvent.click(modelSelect);
  assert.ok(await screen.findByRole("option", { name: /Kimi for Coding.*not in this computer's config/ }));
});
