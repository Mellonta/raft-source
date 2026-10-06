import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import MachineDetailPanel from "../src/components/machine/MachineDetailPanel";
import { en } from "../src/i18n/messages/en";
import { zhCn as zh } from "../src/i18n/messages/zh-cn";
import { useAgentStore } from "../src/store/agentStore";
import { useMachineStore } from "../src/store/machineStore";
import type { Machine, MachineUpgradeRequest } from "../src/store/machineStore";
import {
  REMOTE_COMPUTER_UPGRADE_V2_FLAG_KEY,
  resetServerFeatureFlagsForTests,
  setServerFeatureFlagForTests,
} from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { renderWithIntl, TestIntlProvider } from "./helpers/intl";
import { isRemoteUpgradeSupported } from "@botiverse/raft-shared";

// One test per Computer version / restart / upgrade state of the detail panel
// (copy rework, docs: computer-upgrade-copy-proposal §3-§7). Each asserts the
// status sentence, which buttons show and whether they are enabled, and
// whether the install-then-restart command block shows. The published Computer
// version is 1.0.40 throughout; "too old" means below 1.0.37.

const initialAgentState = useAgentStore.getState();
const initialMachineState = useMachineStore.getState();
const initialServerState = useServerStore.getState();
const originalPost = api.post;

afterEach(() => {
  cleanup();
  api.post = originalPost;
  resetServerFeatureFlagsForTests();
  useAgentStore.setState(initialAgentState, true);
  useMachineStore.setState(initialMachineState, true);
  useServerStore.setState(initialServerState, true);
});

const LATEST = "1.0.40";

function server(role: Server["role"] = "owner"): Server {
  return {
    id: "server-1",
    name: "Acme",
    avatarUrl: null,
    slug: "acme",
    ownerId: "user-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free",
    planDowngradedAt: null,
    role,
    createdAt: "2026-07-13T00:00:00.000Z",
  };
}

type Policy = NonNullable<Machine["computerBroadcastPolicy"]>;

function policy(reasonCode: string, targetVersion: string | null = null): Policy {
  return {
    eligibility: reasonCode === "eligible" ? "eligible" : "no_broadcast",
    targetVersion,
    targetRole: null,
    migrationClass: reasonCode === "eligible" ? "seamless" : null,
    policyRevision: "policy-1",
    reasonCode,
  };
}

function computer(overrides: Partial<Machine> = {}): Machine {
  return {
    id: "computer-1",
    name: "acme-mbp",
    description: null,
    status: "online",
    statusVersion: 1,
    apiKeyPrefix: null,
    runtimes: [],
    hostname: "acme-mbp.local",
    os: "darwin arm64",
    daemonVersion: null,
    isComputer: true,
    computerAttachedByCurrentUser: true,
    computerVersion: "1.0.38",
    computerUpgradeAvailable: false,
    remoteUpgradeSupported: true,
    computerBroadcastPolicy: policy("broadcast_disabled"),
    upgradeRequest: null,
    lastHeartbeat: "2026-07-13T00:00:00.000Z",
    createdAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

// Server shapes for the states the server can actually produce.
const upToDateWebOff = () => computer({ computerVersion: "1.0.40" });
const upToDateWebOn = () => computer({
  computerVersion: "1.0.40",
  computerBroadcastPolicy: policy("already_current", LATEST),
});
const outdatedWebOn = (overrides: Partial<Machine> = {}) => computer({
  computerUpgradeAvailable: true,
  computerBroadcastPolicy: policy("eligible", LATEST),
  ...overrides,
});
const outdatedWebOff = () => computer();
const tooOldWebOn = () => computer({
  computerVersion: "1.0.30",
  remoteUpgradeSupported: false,
  computerUpgradeAvailable: true,
  computerBroadcastPolicy: policy("eligible", LATEST),
});
const tooOldWebOff = () => computer({ computerVersion: "1.0.30", remoteUpgradeSupported: false });

function request(state: MachineUpgradeRequest["state"], observedVersion: string | null = "1.0.38"): MachineUpgradeRequest {
  return {
    id: "request-1",
    targetVersion: LATEST,
    requestedAt: "2026-07-13T00:00:00.000Z",
    state,
    observedVersion,
    reason: state === "failed" ? "version_unchanged" : null,
    resolvedAt: state === "pending" ? null : "2026-07-13T00:10:00.000Z",
  };
}

function renderPanel(
  machine: Machine,
  {
    webUpgrade = false,
    locale = "en",
    role = "owner",
    latest = LATEST,
  }: { webUpgrade?: boolean; locale?: "en" | "zh-cn"; role?: Server["role"]; latest?: string | null } = {},
) {
  useServerStore.setState({ current: server(role), members: [] });
  useAgentStore.setState({ agents: [] });
  useMachineStore.setState({
    machines: [machine],
    computerOperationProgress: {},
    latestComputerVersion: latest,
    loadMachines: async () => {},
  });
  setServerFeatureFlagForTests("server-1", REMOTE_COMPUTER_UPGRADE_V2_FLAG_KEY, webUpgrade);
  return renderWithIntl(
    <MemoryRouter initialEntries={["/s/acme/settings/computers/computer-1"]}>
      <MachineDetailPanel machine={machine} workspaceEmbedded deploymentEnv="production" />
    </MemoryRouter>,
    { locale },
  );
}

const fmt = (template: string, values: Record<string, string> = {}) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? `{${key}}`);

function card() {
  return screen.getByTestId("computer-service-actions");
}

/** Visible button labels in the action row, with disabled state. */
function actionButtons(): Array<{ label: string; disabled: boolean }> {
  const row = within(card()).getByTestId("computer-upgrade-actions");
  return within(row).queryAllByRole("button").map((button) => ({
    label: (button.textContent ?? "").trim(),
    disabled: button.hasAttribute("disabled"),
  }));
}

function versionRow(): string {
  const label = screen.getByText(en["machine.detail.computerVersion"]);
  return (label.parentElement?.parentElement?.textContent ?? "").replace(en["machine.detail.computerVersion"], "").trim();
}

function commandBlock() {
  return within(card()).queryByTestId("computer-upgrade-commands");
}

const PROD_INSTALL = "curl -fsSL https://cdn.raft.build/computer/install.sh | sh";

function assertCommands() {
  const block = commandBlock();
  assert.ok(block, "the install-then-restart command block must show");
  assert.equal(within(block).getByTestId("computer-upgrade-fresh-install").textContent, PROD_INSTALL);
  assert.equal(within(block).getByTestId("computer-upgrade-fresh-restart").textContent, "raft-computer restart");
  // The install command takes the latest release (no version pin), so the
  // step label names no version either.
  assert.ok(within(block).getByText("1. Install the latest version"));
  assert.ok(within(block).getByText(en["machine.detail.upgradeCommands.restartStep"]));
}

function assertNoCommands() {
  assert.equal(commandBlock() === null, true, "no command block: one next step per state");
}

const RESTART = { label: en["machine.detail.restart"], disabled: false };
const UPGRADE = { label: fmt(en["machine.detail.upgradeToVersion"], { version: LATEST }), disabled: false };

// ── 1-2. Up to date ──

test("1. up to date, web upgrade off: 'Up to date.', Restart only, no commands", () => {
  renderPanel(upToDateWebOff());

  // Behavior first (independent of the new copy keys), so RED on the old
  // panel names the real defect.
  assert.equal(within(card()).queryByTestId("computer-upgrade-fresh-install") === null, true, "an up-to-date Computer gets no upgrade commands");
  assert.doesNotMatch(card().textContent ?? "", /eligible/, "an up-to-date Computer is not 'ineligible'");
  assert.equal(versionRow(), `v1.0.40 · ${en["machine.detail.upToDate"]}`);
  assert.ok(within(card()).getByText(en["machine.detail.upgradeStatus.upToDate"]));
  assert.deepEqual(actionButtons(), [RESTART]);
  assertNoCommands();
});

test("2. up to date, web upgrade on: 'Up to date.', Restart + disabled Up to date", () => {
  renderPanel(upToDateWebOn(), { webUpgrade: true });

  assert.equal(versionRow(), `v1.0.40 · ${en["machine.detail.upToDate"]}`);
  assert.ok(within(card()).getByText(en["machine.detail.upgradeStatus.upToDate"]));
  assert.deepEqual(actionButtons(), [RESTART, { label: en["machine.detail.upToDate"], disabled: true }]);
  assertNoCommands();
});

// ── 3-6. A new version exists ──

test("3. new version, web upgrade on: one-click Upgrade, no commands", () => {
  renderPanel(outdatedWebOn(), { webUpgrade: true });

  assert.equal(versionRow(), `v1.0.38 · ${fmt(en["machine.detail.versionAvailable"], { version: LATEST })}`);
  assert.ok(within(card()).getByText(fmt(en["machine.detail.upgradeStatus.available"], { version: LATEST })));
  assert.deepEqual(actionButtons(), [RESTART, UPGRADE]);
  assertNoCommands();
});

// 4-6 are one state: a new version exists and the one-click web upgrade is
// not offered (web upgrade off, or this version is too old for it). Each
// input stays a fixture; the expected card is shared.
const RUN_COMMANDS = "v1.0.40 is available. Run these two commands on that machine to upgrade:";

test("4-6. shared runCommands sentence copy (en + zh)", () => {
  assert.equal(fmt(en["machine.detail.upgradeStatus.runCommands"], { version: LATEST }), RUN_COMMANDS);
  assert.equal(
    fmt(zh["machine.detail.upgradeStatus.runCommands"], { version: LATEST }),
    "有新版本 v1.0.40。在那台机器上运行下面两条命令升级：",
  );
});

const NO_ONE_CLICK_CASES: Array<{ name: string; machine: () => Machine; webUpgrade: boolean; version: string }> = [
  { name: "4. new version, web upgrade off", machine: outdatedWebOff, webUpgrade: false, version: "1.0.38" },
  { name: "5. too old for the web, web upgrade on", machine: tooOldWebOn, webUpgrade: true, version: "1.0.30" },
  { name: "6. too old, web upgrade off", machine: tooOldWebOff, webUpgrade: false, version: "1.0.30" },
];

for (const c of NO_ONE_CLICK_CASES) {
  test(`${c.name}: runCommands sentence + the two commands, Restart only`, () => {
    renderPanel(c.machine(), { webUpgrade: c.webUpgrade });

    // No greyed Upgrade button next to a sentence that offers the upgrade.
    assert.equal(
      within(card()).queryAllByRole("button").some((b) => /Upgrade/.test(b.textContent ?? "") && b.hasAttribute("disabled")),
      false,
    );
    assert.equal(versionRow(), `v${c.version} · ${fmt(en["machine.detail.versionAvailable"], { version: LATEST })}`);
    assert.equal(within(card()).getByTestId("computer-upgrade-status").textContent, RUN_COMMANDS);
    assert.deepEqual(actionButtons(), [RESTART]);
    assertCommands();
  });
}

// ── 7-9. No answer yet ──

test("7. can't check for a new version (release lookup failed for this machine): Restart only, no fresh install", () => {
  renderPanel(computer({ computerBroadcastPolicy: policy("hands_artifact_missing") }), { webUpgrade: true });

  assert.equal(versionRow(), "v1.0.38");
  assert.ok(within(card()).getByText(en["machine.detail.upgradeStatus.cannotCheck"]));
  assert.deepEqual(actionButtons(), [RESTART]);
  assertNoCommands();
});

test("7b. can't check: no published version known to the web", () => {
  renderPanel(outdatedWebOff(), { latest: null });

  assert.equal(versionRow(), "v1.0.38");
  assert.ok(within(card()).getByText(en["machine.detail.upgradeStatus.cannotCheck"]));
  assert.deepEqual(actionButtons(), [RESTART]);
  assertNoCommands();
});

test("8. version unknown, web upgrade off: reading the version, Restart only", () => {
  renderPanel(computer({ computerVersion: null, remoteUpgradeSupported: null }));

  assert.equal(versionRow(), en["machine.detail.readingVersion"]);
  assert.ok(within(card()).getByText(en["machine.detail.upgradeStatus.readingVersion"]));
  assert.deepEqual(actionButtons(), [RESTART]);
  assertNoCommands();
});

test("9. version unknown, web upgrade on: no 'This version can't be upgraded' verdict, Restart only", () => {
  renderPanel(
    computer({ computerVersion: null, remoteUpgradeSupported: null, computerBroadcastPolicy: policy("source_missing") }),
    { webUpgrade: true },
  );

  assert.equal(versionRow(), en["machine.detail.readingVersion"]);
  assert.ok(within(card()).getByText(en["machine.detail.upgradeStatus.readingVersion"]));
  assert.deepEqual(actionButtons(), [RESTART]);
  assertNoCommands();
});

// ── 9b. Prerelease Computer versions (full SemVer, the server's comparison) ──
//
// Staging / rc / branch builds report SemVer prerelease versions. The server's
// policy treats them as valid and orders them by SemVer (a prerelease sorts
// below its release), so the web must not turn them into "Can't check".

const STAGING_AHEAD = "1.0.41-staging.20261003090435.sha.4f9786e3e10a";
const STAGING_SAME = "1.0.40-staging.20260930120000.sha.0123456789ab";

test("9b. staging build ahead of the latest release (1.0.41-staging.* vs 1.0.40): Up to date", () => {
  // What the server sends for it: web off -> gate closed; web on -> already_current.
  for (const webUpgrade of [false, true]) {
    cleanup();
    renderPanel(
      computer({
        computerVersion: STAGING_AHEAD,
        remoteUpgradeSupported: isRemoteUpgradeSupported(STAGING_AHEAD),
        computerBroadcastPolicy: webUpgrade ? policy("already_current", LATEST) : policy("broadcast_disabled"),
      }),
      { webUpgrade },
    );
    assert.equal(within(card()).getByTestId("computer-upgrade-status").textContent, en["machine.detail.upgradeStatus.upToDate"]);
    assert.equal(versionRow(), `v${STAGING_AHEAD} · ${en["machine.detail.upToDate"]}`);
    assertNoCommands();
  }
});

const PRERELEASE_BELOW_RELEASE = [STAGING_SAME, "1.0.40-rc.1", "1.0.39-staging.20260925080000.sha.89abcdef0123", "1.0.38-constructed-wake-context.1"];
for (const version of PRERELEASE_BELOW_RELEASE) {
  test(`9b. prerelease below the release (${version} vs 1.0.40): a new version exists, the two commands`, () => {
    renderPanel(computer({ computerVersion: version, remoteUpgradeSupported: isRemoteUpgradeSupported(version) }));

    assert.equal(within(card()).getByTestId("computer-upgrade-status").textContent, RUN_COMMANDS);
    assert.equal(versionRow(), `v${version} · ${fmt(en["machine.detail.versionAvailable"], { version: LATEST })}`);
    assertCommands();
  });
}

// The server shape for a prerelease Computer with web upgrade on and an
// eligible policy; remoteUpgradeSupported is what the server computes for it.
const prereleaseWebOn = (version: string) => computer({
  computerVersion: version,
  remoteUpgradeSupported: isRemoteUpgradeSupported(version),
  computerUpgradeAvailable: true,
  computerBroadcastPolicy: policy("eligible", LATEST),
});

test("9b. prerelease of a release too old for the web (1.0.36-rc.1, 1.0.37-rc.1), web upgrade on: the two commands, no Upgrade", () => {
  for (const version of ["1.0.36-rc.1", "1.0.37-rc.1"]) {
    cleanup();
    renderPanel(prereleaseWebOn(version), { webUpgrade: true });

    assert.equal(within(card()).queryByRole("button", { name: UPGRADE.label }) === null, true, `${version}: no one-click Upgrade`);
    assert.equal(within(card()).getByTestId("computer-upgrade-status").textContent, RUN_COMMANDS, version);
    assert.deepEqual(actionButtons(), [RESTART]);
    assertCommands();
  }
});

test("9b. prerelease at or above the first web-upgradable release (1.0.38-rc.1), web upgrade on: one-click Upgrade", () => {
  renderPanel(prereleaseWebOn("1.0.38-rc.1"), { webUpgrade: true });

  assert.deepEqual(actionButtons(), [RESTART, UPGRADE]);
  assertNoCommands();
});

test("9b. a version that is not SemVer still reads as can't check", () => {
  for (const version of ["1.0.x", "1.0.40-", "01.0.40", "1.0.40-rc.01"]) {
    cleanup();
    renderPanel(computer({ computerVersion: version, remoteUpgradeSupported: isRemoteUpgradeSupported(version) }));
    assert.equal(
      within(card()).getByTestId("computer-upgrade-status").textContent,
      en["machine.detail.upgradeStatus.cannotCheck"],
      version,
    );
    assertNoCommands();
  }
});

test("9b. a failed upgrade from a prerelease Computer keeps its failure line with the full version", () => {
  renderPanel(
    computer({
      computerVersion: "1.0.40-rc.1",
      remoteUpgradeSupported: isRemoteUpgradeSupported("1.0.40-rc.1"),
      computerBroadcastPolicy: policy("eligible", LATEST),
      computerUpgradeAvailable: true,
      upgradeRequest: request("failed", "1.0.40-rc.1"),
    }),
    { webUpgrade: true },
  );

  assert.equal(
    within(card()).getByTestId("computer-upgrade-request-outcome").textContent,
    fmt(en["machine.detail.upgradeStatus.failed"], { version: "1.0.40-rc.1", command: "raft-computer status" }),
  );
});

// ── 10-13. Upgrade request lifecycle ──

test("10. upgrading: says the Computer will disconnect briefly; only a disabled Upgrading… button", () => {
  renderPanel(outdatedWebOn({ upgradeRequest: request("pending", null) }), { webUpgrade: true });

  assert.ok(within(card()).getByText(fmt(en["machine.detail.upgradeStatus.inProgress"], { version: LATEST })));
  assert.deepEqual(actionButtons(), [{ label: en["machine.detail.upgradeV2.inProgress"], disabled: true }]);
  assertNoCommands();
});

test("11. this upgrade failed: Upgrade is clickable again and the failure line names v-version and the status command", () => {
  renderPanel(outdatedWebOn({ upgradeRequest: request("failed") }), { webUpgrade: true });

  assert.ok(within(card()).getByText(fmt(en["machine.detail.upgradeStatus.available"], { version: LATEST })));
  assert.deepEqual(actionButtons(), [RESTART, UPGRADE]);
  assert.equal(
    within(card()).getByTestId("computer-upgrade-request-outcome").textContent,
    fmt(en["machine.detail.upgradeStatus.failed"], { version: "1.0.38", command: "raft-computer status" }),
  );
  assertNoCommands();
});

test("12. the last upgrade got no response (Computer back on the old version)", () => {
  renderPanel(outdatedWebOn({ upgradeRequest: request("no_response", null) }), { webUpgrade: true });

  assert.deepEqual(actionButtons(), [RESTART, UPGRADE]);
  assert.equal(
    within(card()).getByTestId("computer-upgrade-request-outcome").textContent,
    fmt(en["machine.detail.upgradeStatus.noResponse"], { command: "raft-computer status" }),
  );
});

test("13. stale failure after a manual upgrade: hidden once the machine reached the target", () => {
  renderPanel({ ...upToDateWebOn(), upgradeRequest: request("failed") }, { webUpgrade: true });

  // Behavior first (independent of the new copy keys), so RED on the old
  // panel names the real defect.
  assert.equal(within(card()).queryByTestId("computer-upgrade-request-outcome") === null, true, "stale failure line must be hidden");
  assert.equal(card().textContent?.includes("1.0.38"), false, "no 'still on v1.0.38' next to v1.0.40");
  assert.ok(within(card()).getByText(en["machine.detail.upgradeStatus.upToDate"]));
  assertNoCommands();
});

test("13b. stale no-response after a manual upgrade with web upgrade off: hidden too", () => {
  renderPanel({ ...upToDateWebOff(), upgradeRequest: request("no_response", null) });

  assert.equal(within(card()).queryByTestId("computer-upgrade-request-outcome") === null, true);
});

// ── 14-17. Clicking Upgrade is refused, mapped by code ──

function refuseUpgradeWith(status: number, code: string | undefined) {
  const calls: string[] = [];
  api.post = (async (url: string) => {
    calls.push(url);
    throw Object.assign(new Error("refused"), {
      response: { status, data: code ? { code, error: "Server English that must not render" } : {} },
    });
  }) as typeof api.post;
  return calls;
}

async function clickUpgrade() {
  fireEvent.click(within(card()).getByRole("button", { name: UPGRADE.label }));
  await waitFor(() => assert.equal(within(card()).queryByRole("button", { name: UPGRADE.label }) === null
    || within(card()).queryByTestId("computer-upgrade-request-outcome") !== null, true));
}

test("14. refused remote_upgrade_disabled: #4-6 sentence + commands", async () => {
  const calls = refuseUpgradeWith(403, "remote_upgrade_disabled");
  renderPanel(outdatedWebOn(), { webUpgrade: true });
  await clickUpgrade();

  assert.deepEqual(calls, ["/servers/server-1/machines/computer-1/computer/upgrade"]);
  assert.equal(within(card()).getByTestId("computer-upgrade-status").textContent, RUN_COMMANDS);
  assert.deepEqual(actionButtons(), [RESTART]);
  assertCommands();
  assert.equal(card().textContent?.includes("Server English"), false);
});

test("15. refused computer_remote_upgrade_unsupported: #4-6 sentence + commands", async () => {
  refuseUpgradeWith(409, "computer_remote_upgrade_unsupported");
  renderPanel(outdatedWebOn(), { webUpgrade: true });
  await clickUpgrade();

  assert.equal(within(card()).getByTestId("computer-upgrade-status").textContent, RUN_COMMANDS);
  assert.deepEqual(actionButtons(), [RESTART]);
  assertCommands();
});

test("16. refused computer_broadcast_not_eligible: 'can't be upgraded from the web right now' + commands", async () => {
  refuseUpgradeWith(503, "computer_broadcast_not_eligible");
  renderPanel(outdatedWebOn(), { webUpgrade: true });
  await clickUpgrade();

  assert.ok(within(card()).getByText(en["machine.detail.upgradeStatus.refusedNotAllowed"]));
  assert.deepEqual(actionButtons(), [RESTART]);
  assertCommands();
  assert.equal(card().textContent?.includes("Server English"), false);
});

test("17. refused with any other code: 'try again later', Upgrade stays clickable", async () => {
  refuseUpgradeWith(409, "computer_offline");
  renderPanel(outdatedWebOn(), { webUpgrade: true });
  await clickUpgrade();

  assert.deepEqual(actionButtons(), [RESTART, UPGRADE]);
  assert.equal(
    within(card()).getByTestId("computer-upgrade-request-outcome").textContent,
    en["machine.detail.upgradeStatus.refusedUnknown"],
  );
  assertNoCommands();
  assert.equal(card().textContent?.includes("Server English"), false);
});

// ── 17b. A refusal holds only while nothing that decides availability changed ──
//
// Same mount throughout: the refusal is remembered under the inputs it was
// refused with (web-upgrade flag, policy eligibility / reason / revision /
// target, remoteUpgradeSupported, version). Any change drops it for good, so
// the card follows the live answer again.

function showMachine(view: ReturnType<typeof renderPanel>, machine: Machine) {
  act(() => useMachineStore.setState({ machines: [machine] }));
  view.rerender(
    <TestIntlProvider>
      <MemoryRouter initialEntries={["/s/acme/settings/computers/computer-1"]}>
        <MachineDetailPanel machine={machine} workspaceEmbedded deploymentEnv="production" />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

function setWebUpgrade(enabled: boolean) {
  act(() => setServerFeatureFlagForTests("server-1", REMOTE_COMPUTER_UPGRADE_V2_FLAG_KEY, enabled));
}

function assertOneClick() {
  assert.deepEqual(actionButtons(), [RESTART, UPGRADE]);
  assert.ok(within(card()).getByText(fmt(en["machine.detail.upgradeStatus.available"], { version: LATEST })));
  assertNoCommands();
}

test("17b. refused remote_upgrade_disabled, then web upgrade switched off and on again (same version): Upgrade is back", async () => {
  const calls = refuseUpgradeWith(403, "remote_upgrade_disabled");
  renderPanel(outdatedWebOn(), { webUpgrade: true });
  await clickUpgrade();
  assertCommands();

  setWebUpgrade(false);
  assertCommands();
  setWebUpgrade(true);

  assertOneClick();
  fireEvent.click(within(card()).getByRole("button", { name: UPGRADE.label }));
  await waitFor(() => assert.equal(calls.length, 2, "the Upgrade button sends a new request"));
});

test("17b. refused computer_broadcast_not_eligible, then a fresh eligible policy: Upgrade is back", async () => {
  refuseUpgradeWith(503, "computer_broadcast_not_eligible");
  const view = renderPanel(outdatedWebOn(), { webUpgrade: true });
  await clickUpgrade();
  assert.ok(within(card()).getByText(en["machine.detail.upgradeStatus.refusedNotAllowed"]));

  showMachine(view, outdatedWebOn({ computerBroadcastPolicy: { ...policy("eligible", LATEST), policyRevision: "policy-2" } }));

  assertOneClick();
});

test("17b. refused while the release lookup briefly failed, then the same eligible policy again: Upgrade is back", async () => {
  refuseUpgradeWith(503, "computer_broadcast_not_eligible");
  const view = renderPanel(outdatedWebOn(), { webUpgrade: true });
  await clickUpgrade();
  assert.ok(within(card()).getByText(en["machine.detail.upgradeStatus.refusedNotAllowed"]));

  showMachine(view, computer({ computerBroadcastPolicy: policy("hands_unavailable") }));
  showMachine(view, outdatedWebOn());

  assertOneClick();
});

test("17b. refused computer_remote_upgrade_unsupported, then the server reports remote upgrade supported again: Upgrade is back", async () => {
  refuseUpgradeWith(409, "computer_remote_upgrade_unsupported");
  const view = renderPanel(outdatedWebOn(), { webUpgrade: true });
  await clickUpgrade();
  assertCommands();

  showMachine(view, outdatedWebOn({ remoteUpgradeSupported: false }));
  showMachine(view, outdatedWebOn());

  assertOneClick();
});

test("17b. negative control: refused, then nothing that decides availability changes: the refusal holds", async () => {
  refuseUpgradeWith(403, "remote_upgrade_disabled");
  const view = renderPanel(outdatedWebOn(), { webUpgrade: true });
  await clickUpgrade();
  assertCommands();

  // A fresh machine object and a re-published flag with the same values.
  showMachine(view, outdatedWebOn({ lastHeartbeat: "2026-07-13T00:05:00.000Z" }));
  setWebUpgrade(true);

  assert.equal(within(card()).getByTestId("computer-upgrade-status").textContent, RUN_COMMANDS);
  assert.deepEqual(actionButtons(), [RESTART]);
  assertCommands();
});

// ── 18-21. Other viewers / statuses ──

test("18. non-admin, new version: version row + 'ask an admin', no Actions", () => {
  renderPanel(
    computer({ computerAttachedByCurrentUser: false, creator: null }),
    { role: "member" },
  );

  assert.equal(screen.queryByTestId("computer-service-actions") === null, true);
  assert.equal(versionRow(), `v1.0.38 · ${fmt(en["machine.detail.versionAvailable"], { version: LATEST })}`);
  assert.ok(screen.getByText(fmt(en["machine.detail.upgradeStatus.askAdmin"], { version: LATEST })));
});

test("19. restart request fails without a server message: the action is localized in zh", async () => {
  api.post = (async () => {
    throw Object.assign(new Error("network"), { response: undefined });
  }) as typeof api.post;
  renderPanel(upToDateWebOff(), { locale: "zh-cn" });

  fireEvent.click(within(card()).getByRole("button", { name: zh["machine.detail.restart"] }));
  const line = await waitFor(() => within(card()).getByText(zh["machine.detail.restartRequestFailed"]));
  assert.equal(line.textContent, "请求重启失败。Computer 必须在线。", "no English action word inside zh copy");
});

test("20. offline, admin: version row says a new version exists; offline card unchanged", () => {
  renderPanel(computer({ status: "offline", computerUpgradeAvailable: true, computerBroadcastPolicy: policy("eligible", LATEST) }));

  assert.equal(versionRow(), `v1.0.38 · ${fmt(en["machine.detail.versionAvailable"], { version: LATEST })}`);
  assert.ok(screen.getByTestId("computer-recovery-card"));
  assert.equal(screen.queryByTestId("computer-service-actions") === null, true);
});

test("21. offline, non-admin: version row + admin-only line", () => {
  renderPanel(
    computer({ status: "offline", computerAttachedByCurrentUser: false, creator: null }),
    { role: "member" },
  );

  assert.equal(versionRow(), `v1.0.38 · ${fmt(en["machine.detail.versionAvailable"], { version: LATEST })}`);
  assert.ok(screen.getByTestId("computer-recovery-card"));
  assert.equal(screen.queryByText(fmt(en["machine.detail.upgradeStatus.askAdmin"], { version: LATEST })) === null, true);
});

// 22. Sidebar row: computerUpgradeSidebarRow.behavior.test.tsx (importing
// Sidebar next to MachineDetailPanel in one file stalls module loading).

// ── 23. Card title and delete strings keep the shipped zh 计算机 ──
// #8831 moved these three to "Computer", but "Computer" renders as 计算机 on every
// other surface and catalogConsistencyRatchet forbids a second translation without
// a ruling (@AngLee). They stay 计算机 together until that ruling.

test("23. zh: card title and delete strings say 计算机, consistent with the rest of the catalog", () => {
  renderPanel(upToDateWebOff(), { locale: "zh-cn" });

  assert.equal(card().querySelector(".text-sm.font-bold")?.textContent, "计算机");
  assert.equal(zh["machine.detail.deleteComputer"], "删除计算机");
  assert.equal(zh["machine.detail.cannotDeleteComputer"], "无法删除计算机");
  assert.ok(screen.getAllByText("删除计算机").length > 0, "delete card title and button");
});

test("restart tooltip replaces the repeated 'restart it if unresponsive' line", () => {
  renderPanel(outdatedWebOn(), { webUpgrade: true });

  assert.equal(card().textContent?.includes("stops responding"), false);
  assert.equal(en["machine.detail.restartTooltip"], "Use this to restart when the Computer isn't responding.");
});
