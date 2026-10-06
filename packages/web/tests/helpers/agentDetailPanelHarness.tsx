import assert from "node:assert/strict";

import { cleanup, render } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { AGENT_MIGRATION_FEATURE_FLAG_KEY, getStaticRuntimeModelSourceSet } from "@botiverse/raft-shared";
import type { RuntimeSelectionOption } from "@botiverse/raft-shared";
import api from "../../src/api/client";
import { REGISTERED_SERVER_FEATURE_FLAG_KEYS } from "../../src/store/serverFeatureFlags";
import AgentDetailPanel from "../../src/components/agent/AgentDetailPanel";
import type { Locale } from "../../src/i18n/locale";
import type { Agent } from "../../src/store/agentStore";
import { useAgentStore } from "../../src/store/agentStore";
import { useAuthStore } from "../../src/store/authStore";
import { useChannelStore } from "../../src/store/channelStore";
import { useMachineStore } from "../../src/store/machineStore";
import { useServerStore } from "../../src/store/serverStore";
import { useThreadStore } from "../../src/store/threadStore";
import { TestIntlProvider } from "./intl";

const originalPost = api.post.bind(api);
const originalGet = api.get.bind(api);
const originalPatch = api.patch.bind(api);
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

export function resetAgentDetailPanelState() {
  cleanup();
  api.post = originalPost;
  api.get = originalGet;
  api.patch = originalPatch;
  useAgentStore.setState({ agents: [], activityLogs: {}, agentActivities: {} });
  useChannelStore.setState({ channels: [], dmChannels: [], loading: true });
  useMachineStore.setState({ machines: [], loading: false });
  useServerStore.setState({
    current: null,
    members: [],
    billing: null,
    loadingBilling: false,
    sidebarOrder: {
      channelOrder: [],
      agentOrder: [],
      dmOrder: [],
      channelSortMode: "manual",
      jointChannelSortMode: "manual",
      dmSortMode: "manual",
      pinnedSortMode: "manual",
      pinnedChannelIds: [],
      pinnedAgentIds: [],
      pinnedOrder: [],
      hiddenDmIds: [],
      channelPanelTabOrder: [],
      agentPanelTabOrder: [],
      pinnedVersion: 0,
    },
  });
  useAuthStore.setState({ user: null });
  useThreadStore.setState({ threads: {} });
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
}


export function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    serverId: "server-1",
    name: "migration-agent",
    displayName: "Migration Agent",
    avatarUrl: null,
    description: null,
    status: "offline",
    model: "gpt-5",
    runtime: "codex",
    external: false,
    serverRole: null,
    runtimeConfig: null,
    lastRuntimeError: null,
    reasoningEffort: null,
    executionMode: "cloud",
    envVars: null,
    machineId: "source-machine",
    creatorType: null,
    creatorId: null,
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: "2026-07-09T00:00:00.000Z",
    ...overrides,
  };
}

export function seedPanelState(serverId: string, agent: Agent = makeAgent({ serverId })) {
  useAuthStore.setState({
    user: {
      id: "owner-user",
      email: "owner@example.com",
      gravatarHash: "",
      name: "owner",
      displayName: "Owner",
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationDisplay: "original",
      preferredTimeFormat: null,
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
  });
  useServerStore.setState({
    current: {
      id: serverId,
      name: "Botiverse",
      avatarUrl: null,
      slug: "botiverse",
      ownerId: "owner-user",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "team",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-07-09T00:00:00.000Z",
    },
    members: [{
      userId: "owner-user",
      email: "owner@example.com",
      gravatarHash: "",
      name: "owner",
      displayName: "Owner",
      description: null,
      avatarUrl: null,
      role: "owner",
      joinedAt: "2026-07-09T00:00:00.000Z",
    }],
    sidebarOrder: {
      channelOrder: [],
      agentOrder: [],
      dmOrder: [],
      channelSortMode: "manual",
      jointChannelSortMode: "manual",
      dmSortMode: "manual",
      pinnedSortMode: "manual",
      pinnedChannelIds: [],
      pinnedAgentIds: [],
      pinnedOrder: [],
      hiddenDmIds: [],
      channelPanelTabOrder: [],
      agentPanelTabOrder: [],
      pinnedVersion: 0,
    },
  });
  useMachineStore.setState({
    machines: [
      {
        id: "source-machine",
        name: "Source Computer",
        description: null,
        status: "online",
        statusVersion: 1,
        apiKeyPrefix: null,
        runtimes: [],
        hostname: null,
        os: null,
        daemonVersion: null,
        isComputer: true,
        computerUpgradeAvailable: false,
        lastHeartbeat: null,
        createdAt: "2026-07-09T00:00:00.000Z",
      },
      {
        id: "target-machine",
        name: "Target Computer",
        description: null,
        status: "online",
        statusVersion: 1,
        apiKeyPrefix: null,
        runtimes: [],
        hostname: null,
        os: null,
        daemonVersion: null,
        isComputer: true,
        computerUpgradeAvailable: false,
        lastHeartbeat: null,
        createdAt: "2026-07-09T00:00:00.000Z",
      },
    ],
    loading: false,
  });
  useAgentStore.setState({ agents: [agent], activityLogs: {}, agentActivities: {} });
  return agent;
}

export function LocationProbe() {
  const location = useLocation();
  return (
    <>
      <output data-testid="location">{location.pathname}</output>
      <output data-testid="location-search">{location.search}</output>
    </>
  );
}

export function renderPanel(agent: Agent, locale: Locale = "en") {
  return render(
    <TestIntlProvider locale={locale}>
      <MemoryRouter initialEntries={["/s/botiverse/agent/agent-1"]}>
        <AgentDetailPanel agent={agent} />
        <LocationProbe />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

export function stubAgentDetailApi(
  migration: unknown = null,
  billingPlanOrModelPayload: unknown = "pro",
  explicitModelPayload?: unknown,
) {
  const billingPlan = typeof billingPlanOrModelPayload === "string"
    ? billingPlanOrModelPayload
    : "pro";
  const modelPayload = typeof billingPlanOrModelPayload === "string"
    ? explicitModelPayload
    : billingPlanOrModelPayload;
  api.get = async (url: string) => {
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } } as never;
    if (url === "/agents/agent-1/runtime-options") {
      const agent = useAgentStore.getState().agents.find((candidate) => candidate.id === "agent-1");
      const machine = useMachineStore.getState().machines.find((candidate) => candidate.id === agent?.machineId);
      const runtimeId = agent?.runtime ?? "codex";
      const capabilityAvailable = machine?.runtimes.includes(runtimeId) === true;
      const admissionReason = runtimeId === "grok"
        ? "feature_flag_off" as const
        : runtimeId === "kimi" || runtimeId === "gemini"
          ? "deprecated" as const
          : null;
      const option: RuntimeSelectionOption = {
        runtimeId,
        capabilityStatus: capabilityAvailable ? "available" : "not_installed",
        admissionStatus: admissionReason ? "grandfathered_current" : "available_for_new",
        admissionReason,
        current: true,
        availableForNew: admissionReason === null,
        manageableForCurrentAgent: capabilityAvailable,
        canSelectInThisContext: capabilityAvailable,
      };
      return {
        data: {
          context: "existing_agent",
          machineId: machine?.id ?? null,
          options: [option],
        },
      } as never;
    }
    if (url === "/agents/agent-1/migration") {
      return { data: { migration } } as never;
    }
    if (url === "/billing/subscription") {
      return {
        data: {
          plan: billingPlan,
          displayName: billingPlan === "free" ? "Free" : "Pro",
          serverPlan: billingPlan,
          source: "server",
          capacity: {
            maxHumans: 3,
            maxAgents: 3,
            maxUniversalSeats: 0,
          },
          usage: {
            humans: 1,
            agents: 1,
            universalSeats: 0,
          },
          provisioned: {
            humans: 1,
            agents: 1,
            proPackQuantity: 0,
            trialFreePackQuantity: 0,
          },
          price: null,
          subscription: null,
          stripeConfigured: true,
          permissions: {
            canReadBillingSummary: true,
            canManageBilling: true,
          },
        },
      } as never;
    }
    if (url.includes("/runtime-models/") && modelPayload !== undefined) {
      return { data: modelPayload } as never;
    }
    if (url.includes("/runtime-models/")) {
      const staticSource = getStaticRuntimeModelSourceSet(url.split("/").at(-1) ?? "");
      if (staticSource) {
        return { data: { kind: "live", value: staticSource } } as never;
      }
    }
    return { data: { reminders: [] } } as never;
  };
}

export function stubMigrationFeatureFlag(serverId: string) {
  api.post = async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      assert.deepEqual(body, {
        serverId,
        platform: "web",
        keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
      });
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };
}
