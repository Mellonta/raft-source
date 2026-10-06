import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import MachineDetailPanel from "../src/components/machine/MachineDetailPanel";
import type { Locale } from "../src/i18n/locale";
import { useAgentStore } from "../src/store/agentStore";
import { useMachineStore } from "../src/store/machineStore";
import type { Machine } from "../src/store/machineStore";
import {
  REMOTE_COMPUTER_UPGRADE_V2_FLAG_KEY,
  resetServerFeatureFlagsForTests,
  setServerFeatureFlagForTests,
} from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { renderWithIntl } from "./helpers/intl";

const initialAgentState = useAgentStore.getState();
const initialMachineState = useMachineStore.getState();
const initialServerState = useServerStore.getState();

afterEach(() => {
  cleanup();
  resetServerFeatureFlagsForTests();
  useAgentStore.setState(initialAgentState, true);
  useMachineStore.setState(initialMachineState, true);
  useServerStore.setState(initialServerState, true);
});

const server: Server = {
  id: "server-1",
  name: "Acme",
  avatarUrl: null,
  slug: "acme",
  ownerId: "user-1",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "free",
  planDowngradedAt: null,
  role: "owner",
  createdAt: "2026-07-13T00:00:00.000Z",
};

const outdatedComputer: Machine = {
  id: "computer-1",
  name: "Office Mac",
  description: null,
  status: "online",
  statusVersion: 1,
  apiKeyPrefix: null,
  runtimes: [],
  hostname: "office-mac.local",
  os: "darwin",
  daemonVersion: null,
  isComputer: true,
  computerAttachedByCurrentUser: true,
  computerVersion: "1.0.39",
  computerUpgradeAvailable: true,
  computerBroadcastPolicy: {
    eligibility: "eligible",
    targetVersion: "1.0.40",
    targetRole: null,
    migrationClass: null,
    policyRevision: "policy-1",
    reasonCode: null,
  },
  lastHeartbeat: null,
  createdAt: "2026-07-13T00:00:00.000Z",
};

const notes = {
  version: "1.0.40",
  en: "- Faster startup\n- Fixed proxy decoding",
  "zh-CN": "- 启动更快\n- 修复代理解码",
};

function renderPanel({
  machine = outdatedComputer,
  releaseNotes = notes,
  locale,
}: {
  machine?: Machine;
  releaseNotes?: typeof notes | { version: string; en: string } | null;
  locale?: Locale;
} = {}) {
  useServerStore.setState({ current: server, members: [] });
  useAgentStore.setState({ agents: [] });
  // Remote upgrade v2 resolved OFF: the release notes must not depend on it.
  setServerFeatureFlagForTests(server.id, REMOTE_COMPUTER_UPGRADE_V2_FLAG_KEY, false);
  useMachineStore.setState({
    computerOperationProgress: {},
    latestComputerVersion: "1.0.40",
    latestComputerReleaseNotes: releaseNotes,
  });
  return renderWithIntl(
    <MemoryRouter initialEntries={["/s/acme/settings/computers/computer-1"]}>
      <MachineDetailPanel machine={machine} workspaceEmbedded />
    </MemoryRouter>,
    { locale },
  );
}

test("update available + notes: What's new sits in the action row and opens the English notes with remote upgrade v2 off", () => {
  renderPanel();

  const actions = screen.getByTestId("computer-upgrade-actions");
  // Web upgrade off: the card offers the commands instead of an Upgrade button.
  assert.ok(within(actions).queryByRole("button", { name: /Upgrade/ }) === null);
  assert.ok(within(actions).getByRole("button", { name: "What's new" }), "What's new sits in the action row");

  assert.ok(screen.getByText("· v1.0.40 available"));
  assert.ok(screen.queryByTestId("computer-release-notes-dialog") === null);
  fireEvent.click(screen.getByRole("button", { name: "What's new" }));

  const dialog = screen.getByTestId("computer-release-notes-dialog");
  assert.ok(within(dialog).getByRole("heading", { name: "What's new in v1.0.40" }));
  const items = within(dialog).getAllByRole("listitem").map((item) => item.textContent);
  assert.deepEqual(items, ["Faster startup", "Fixed proxy decoding"]);
  assert.ok(within(dialog).queryByText(/启动更快/) === null);

  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  assert.ok(screen.queryByTestId("computer-release-notes-dialog") === null);
});

test("zh-cn UI shows the Chinese notes", () => {
  renderPanel({ locale: "zh-cn" });

  fireEvent.click(screen.getByRole("button", { name: "查看更新内容" }));
  const dialog = screen.getByTestId("computer-release-notes-dialog");
  assert.ok(within(dialog).getByRole("heading", { name: "v1.0.40 更新内容" }));
  const items = within(dialog).getAllByRole("listitem").map((item) => item.textContent);
  assert.deepEqual(items, ["启动更快", "修复代理解码"]);
  assert.ok(within(dialog).queryByText(/Faster startup/) === null);
});

test("zh-cn UI falls back to English when only English notes exist", () => {
  renderPanel({ locale: "zh-cn", releaseNotes: { version: "1.0.40", en: "- Faster startup" } });

  fireEvent.click(screen.getByRole("button", { name: "查看更新内容" }));
  const dialog = screen.getByTestId("computer-release-notes-dialog");
  assert.deepEqual(within(dialog).getAllByRole("listitem").map((item) => item.textContent), ["Faster startup"]);
});

test("no affordance when the notes are for a different version than the upgrade target", () => {
  renderPanel({ releaseNotes: { ...notes, version: "1.0.41" } });

  assert.ok(screen.getByText("· v1.0.40 available"));
  assert.equal(screen.queryByTestId("computer-release-notes-open") === null, true, "What's new must be hidden");
});

test("Upgrade button removed (broadcast disabled): What's new still shows in the action row", () => {
  renderPanel({
    machine: {
      ...outdatedComputer,
      computerBroadcastPolicy: {
        eligibility: "no_broadcast",
        targetVersion: null,
        targetRole: null,
        migrationClass: null,
        policyRevision: "policy-1",
        reasonCode: "broadcast_disabled",
      },
    },
  });

  const actions = screen.getByTestId("computer-upgrade-actions");
  assert.equal(within(actions).queryByRole("button", { name: /Upgrade/ }) === null, true, "no Upgrade button");
  assert.ok(within(actions).getByRole("button", { name: "What's new" }));
});

test("offline Computer with an update: What's new sits beside the update hint", () => {
  renderPanel({ machine: { ...outdatedComputer, status: "offline" } });

  assert.equal(screen.queryByTestId("computer-upgrade-actions") === null, true, "no action row offline");
  const hint = screen.getByText("· v1.0.40 available");
  assert.ok(hint.parentElement && within(hint.parentElement).getByRole("button", { name: "What's new" }));
});

test("offline Computer: no affordance when the notes are for a different version than the upgrade target", () => {
  renderPanel({ machine: { ...outdatedComputer, status: "offline" }, releaseNotes: { ...notes, version: "1.0.41" } });

  assert.ok(screen.getByText("· v1.0.40 available"));
  assert.equal(screen.queryByTestId("computer-release-notes-open") === null, true, "What's new must be hidden");
});

test("no affordance without notes", () => {
  renderPanel({ releaseNotes: null });

  assert.ok(screen.getByText("· v1.0.40 available"));
  assert.ok(screen.queryByTestId("computer-release-notes-open") === null);
});

test("no affordance when no update is available", () => {
  for (const computerUpgradeAvailable of [false, null] as const) {
    renderPanel({ machine: { ...outdatedComputer, computerVersion: "1.0.40", computerUpgradeAvailable } });

    assert.ok(screen.queryByText("· v1.0.40 available") === null);
    assert.ok(screen.queryByTestId("computer-release-notes-open") === null);
    cleanup();
  }
});
