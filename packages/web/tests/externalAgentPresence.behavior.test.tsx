import "./helpers/domSetup";

// External-agent presence: online while the credential was seen within the
// 120 s window, otherwise "Last active <time ago>"; managed agents unchanged;
// an online external agent never offers Start/Stop.

import assert from "node:assert/strict";
import { act } from "react";
import { createIntl } from "react-intl";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import AgentActivityDot from "../src/components/agent/AgentActivityDot";
import AgentDetailPanel from "../src/components/agent/AgentDetailPanel";
import { mergedMessages } from "../src/i18n/messages";
import {
  reconcileAgentsList,
  resolveAgentDisplayState,
  useAgentStore,
} from "../src/store/agentStore";
import type { Agent } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import { PRESENCE_CLOCK_TICK_MS } from "../src/store/presenceClock";
import { resetServerFeatureFlagsForTests } from "../src/store/serverFeatureFlags";
import { formatAgentDisplayStateText } from "../src/utils/activity";
import { TestIntlProvider } from "./helpers/intl";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

afterEach(() => {
  cleanup();
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useAuthStore.setState({ user: null } as never);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  resetServerFeatureFlagsForTests();
});

test("external agents are online only within 120 s of being seen", () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  const external = (lastSeenAt: string | null) =>
    resolveAgentDisplayState({ status: "stopped", lastSeenAt }, undefined, true, NOW);

  const fresh = external(iso(NOW - 119_000));
  assert.equal(fresh.isOnline, true);
  assert.equal(fresh.activity, "online");
  assert.equal(fresh.isExternal, true);

  const stale = external(iso(NOW - 120_000));
  assert.equal(stale.isOnline, false);
  assert.equal(stale.activity, "offline");
  assert.equal(stale.activityText, "Last active 2 minutes ago");

  const never = external(null);
  assert.equal(never.isOnline, false);
  assert.equal(never.activityText, "Offline");
});

test("a seen external agent shows its activity-derived state like a managed agent", () => {
  const seen = { status: "active" as const, lastSeenAt: iso(NOW - 10_000) };
  for (const activity of ["thinking", "working", "error"] as const) {
    const state = resolveAgentDisplayState(
      seen,
      { activity, activityDetail: activity === "working" ? "Using tool: Bash" : "", detailKind: "external_activity" },
      true,
      NOW,
    );
    assert.equal(state.activity, activity);
    assert.equal(state.isOnline, true);
    assert.equal(state.isExternal, true);
    const managed = resolveAgentDisplayState(
      { status: "active" },
      { activity, activityDetail: activity === "working" ? "Using tool: Bash" : "", detailKind: "external_activity" },
      false,
      NOW,
    );
    assert.equal(state.activityText, managed.activityText, `${activity}: same text as a managed agent`);
  }

});

test("an explicit SessionEnd shows offline immediately even while presence is fresh; newer activity brings it back", () => {
  const agent = { id: "ext", name: "ext", status: "active", runtime: "external", external: true, lastSeenAt: iso(NOW - 10_000) } as Agent;
  const sessionEnded = resolveAgentDisplayState(agent, { activity: "offline", activityDetail: "Session ended", detailKind: "external_activity" }, true, NOW);
  assert.equal(sessionEnded.activity, "offline");
  assert.equal(sessionEnded.isOnline, false);
  // Rendered like any offline external agent: "Last active <time>".
  const enIntl = createIntl({ locale: "en", defaultLocale: "en", messages: mergedMessages("en") });
  assert.match(formatAgentDisplayStateText(enIntl, sessionEnded), /^Last active /);

  const resumed = resolveAgentDisplayState(agent, { activity: "working", activityDetail: "Message received", detailKind: "message_received" }, true, NOW);
  assert.equal(resumed.activity, "working");
  assert.equal(resumed.isOnline, true);
});

test("presence floor: a stale external agent is offline regardless of its last activity", () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  const state = resolveAgentDisplayState(
    { status: "active", lastSeenAt: iso(NOW - 120_000) },
    { activity: "working", activityDetail: "Using tool: Bash", detailKind: "external_activity" },
    true,
    NOW,
  );
  assert.equal(state.activity, "offline");
  assert.equal(state.isOnline, false);
  assert.equal(state.activityText, "Last active 2 minutes ago");
});

test("the external dot renders working like a managed agent while seen", () => {
  useAgentStore.setState({
    agents: [{ id: "ext", name: "ext", status: "active", runtime: "external", external: true, lastSeenAt: new Date().toISOString() }],
    agentActivities: { ext: { activity: "working", activityDetail: "", detailKind: "external_activity" } },
  } as never);
  useAgentStore.setState({
    agents: [...useAgentStore.getState().agents, { id: "managed", name: "managed", status: "active", runtime: "claude" }],
    agentActivities: {
      ...useAgentStore.getState().agentActivities,
      managed: { activity: "working", activityDetail: "", detailKind: "other" },
    },
  } as never);
  const view = render(
    <TestIntlProvider>
      <AgentActivityDot agentId="ext" />
      <AgentActivityDot agentId="managed" />
    </TestIntlProvider>,
  );
  const [ext, managed] = Array.from(view.container.children);
  assert.equal(ext!.className, managed!.className);
  assert.doesNotMatch(ext!.className, /(^|\s)bg-brutal-cyan(\s|$)/);
});

test("managed agents ignore lastSeenAt and keep runtime-activity presence", () => {
  const active = resolveAgentDisplayState({ status: "active", lastSeenAt: iso(NOW - 10 * 60_000) }, undefined, false, NOW);
  assert.equal(active.isOnline, true);
  assert.equal(active.isExternal, undefined);
  const stopped = resolveAgentDisplayState({ status: "stopped", lastSeenAt: iso(NOW) }, undefined, false, NOW);
  assert.equal(stopped.isOnline, false);
  assert.equal(stopped.activityDetailKind, "stopped");
});

test("display text reads 'Last active <relative>' in every locale", () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  const state = resolveAgentDisplayState({ status: "active", lastSeenAt: iso(NOW - 5 * 60_000) }, undefined, true, NOW);
  const enIntl = createIntl({ locale: "en", defaultLocale: "en", messages: mergedMessages("en") });
  const zhIntl = createIntl({ locale: "zh-cn", defaultLocale: "en", messages: mergedMessages("zh-cn") });
  assert.equal(formatAgentDisplayStateText(enIntl, state), "Last active 5 minutes ago");
  assert.equal(formatAgentDisplayStateText(zhIntl, state), "上次活跃 5 分钟前");

  const online = resolveAgentDisplayState({ status: "stopped", lastSeenAt: iso(NOW - 1000) }, undefined, true, NOW);
  assert.equal(formatAgentDisplayStateText(enIntl, online), "Online");
});

test("agent:seen advances lastSeenAt forward only and survives an older /agents snapshot", () => {
  const agent = { id: "ext", name: "ext", status: "active", runtime: "external", external: true, lastSeenAt: iso(NOW - 60_000) } as Agent;
  useAgentStore.setState({ agents: [agent] } as never);

  useAgentStore.getState().applyAgentSeen("ext", iso(NOW));
  assert.equal(useAgentStore.getState().agents[0]!.lastSeenAt, iso(NOW));

  const before = useAgentStore.getState().agents;
  useAgentStore.getState().applyAgentSeen("ext", iso(NOW - 30_000));
  assert.equal(useAgentStore.getState().agents, before, "an older push is a no-op (identity preserved)");

  const reconciled = reconcileAgentsList(before, [{ ...agent, lastSeenAt: iso(NOW - 60_000) }]);
  assert.equal(reconciled[0]!.lastSeenAt, iso(NOW), "in-flight REST snapshot must not move lastSeenAt backwards");
});

test("the dot flips from online to neutral external tone as time passes, without a store write", () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: NOW });
  useAgentStore.setState({
    agents: [{ id: "ext", name: "ext", status: "active", runtime: "external", external: true, lastSeenAt: iso(NOW - 100_000) }],
    agentActivities: {},
  } as never);

  const view = render(
    <TestIntlProvider>
      <AgentActivityDot agentId="ext" />
    </TestIntlProvider>,
  );
  const dotClass = () => view.container.firstElementChild?.className ?? "";
  assert.match(dotClass(), /(^|\s)bg-brutal-lime(\s|$)/, "seen 100 s ago → online (lime)");

  act(() => {
    vi.advanceTimersByTime(2 * PRESENCE_CLOCK_TICK_MS);
  });
  assert.match(dotClass(), /(^|\s)bg-brutal-cyan(\s|$)/, "130 s since seen → neutral external tone");
});

test("an online external agent offers no Start/Stop in the agent profile", () => {
  const agent = {
    id: "agent-external-online",
    name: "external-online",
    displayName: "External Online",
    runtime: "external",
    external: true,
    status: "active",
    lastSeenAt: new Date().toISOString(),
    creatorType: "user",
    creatorId: "user-1",
    deletedAt: null,
    lastRuntimeError: null,
    machineId: null,
  };
  useAuthStore.setState({ user: { id: "user-1", name: "Owner" } } as never);
  useServerStore.setState({
    current: { id: "server-1", slug: "playwright-server", name: "Playwright Server", role: "owner" },
    members: [],
  } as never);
  useMachineStore.setState({ machines: [] } as never);
  useChannelStore.setState({ openDM: () => undefined } as never);
  useAgentStore.setState({
    agents: [agent],
    agentActivities: {},
    activityLogs: {},
    fetchExternalAgentStatus: async () => ({ setupState: "connected", credentialLastUsedAt: null, lastActivityAt: null }),
  } as never);

  render(
    <MemoryRouter initialEntries={[`/s/playwright-server/agent/${agent.id}`]}>
      <TestIntlProvider>
        <AgentDetailPanel agent={agent as never} />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.ok(screen.getAllByText("External · Online").length > 0, "profile badge shows the real presence");
  for (const label of ["Stop Agent", "Start Agent"]) {
    assert.ok(screen.queryByRole("button", { name: label }) === null, `no ${label} button for an external agent`);
    assert.ok(screen.queryByText(label) === null, `no ${label} action for an external agent`);
  }
});
