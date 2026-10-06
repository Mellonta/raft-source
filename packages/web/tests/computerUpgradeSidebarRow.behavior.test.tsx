import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, screen } from "@testing-library/react";
import { ComputerRow } from "../src/components/layout/Sidebar";
import { useMachineStore } from "../src/store/machineStore";
import type { Machine } from "../src/store/machineStore";
import { renderWithIntl } from "./helpers/intl";

// State 22 of the Computer upgrade copy rework: the sidebar row says a new
// version exists whenever the web's own comparison finds one (independent of
// whether web upgrade is switched on). The English run label stays lowercase
// ("computer v…", as shipped before #8831): capitalising it collided with the
// existing "Computer offline" / "Computer online" strings in
// catalogConsistencyRatchet.

const initialMachineState = useMachineStore.getState();

afterEach(() => {
  cleanup();
  useMachineStore.setState(initialMachineState, true);
});

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
    computerVersion: "1.0.38",
    computerUpgradeAvailable: false,
    remoteUpgradeSupported: true,
    // Web upgrade switched off server-wide: the policy never compares versions.
    computerBroadcastPolicy: {
      eligibility: "no_broadcast",
      targetVersion: null,
      targetRole: null,
      migrationClass: null,
      policyRevision: "policy-1",
      reasonCode: "broadcast_disabled",
    },
    lastHeartbeat: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

function renderRow(machine: Machine, latest: string | null = "1.0.40") {
  useMachineStore.setState({ machines: [machine], latestComputerVersion: latest });
  return renderWithIntl(<ComputerRow machineId={machine.id} selected={false} onSelect={() => {}} />);
}

const rowText = () => screen.getByTestId("computer-list-item-computer-1").textContent ?? "";
// The dot text rides the RUI tooltip; the tone class is the visible signal.
const dotTone = () => screen.getByTestId("computer-status-dot-computer-1").className;

test("22. new version with web upgrade off: arrow + upgrade dot", () => {
  renderRow(computer());
  assert.match(rowText(), /computer v1\.0\.38→ v1\.0\.40/);
  assert.match(dotTone(), /bg-brutal-pink/);
});

test("22. up to date: no arrow, online dot, run label shows the version", () => {
  renderRow(computer({ computerVersion: "1.0.40" }));
  assert.equal(rowText().includes("→"), false);
  assert.match(rowText(), /computer v1\.0\.40/);
  assert.match(dotTone(), /bg-brutal-lime/);
});

test("22. offline with a new version keeps the arrow", () => {
  renderRow(computer({ status: "offline" }));
  assert.match(rowText(), /computer offline→ v1\.0\.40/);
  assert.match(dotTone(), /bg-brutal-pink/);
});

test("22. no published version known: no arrow", () => {
  renderRow(computer(), null);
  assert.equal(rowText().includes("→"), false);
});

test("22. prerelease below the release (1.0.40-rc.1 vs 1.0.40): arrow to v1.0.40", () => {
  renderRow(computer({ computerVersion: "1.0.40-rc.1" }));
  assert.match(rowText(), /computer v1\.0\.40-rc\.1→ v1\.0\.40/);
  assert.match(dotTone(), /bg-brutal-pink/);
});

test("22. staging build ahead of the release: no arrow, online dot", () => {
  renderRow(computer({ computerVersion: "1.0.41-staging.20261003090435.sha.4f9786e3e10a" }));
  assert.equal(rowText().includes("→"), false);
  assert.match(dotTone(), /bg-brutal-lime/);
});

test("22. older staging build (1.0.39-staging.* vs 1.0.40): arrow to v1.0.40", () => {
  renderRow(computer({ computerVersion: "1.0.39-staging.20260925080000.sha.89abcdef0123" }));
  assert.match(rowText(), /→ v1\.0\.40/);
  assert.match(dotTone(), /bg-brutal-pink/);
});

test("an online Computer under 10% free disk shows a low-disk chip with the free space", () => {
  renderRow(computer({ diskStatus: { availableBytes: 5 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 } }), null);
  const chip = screen.getByTestId("computer-disk-low-computer-1");
  assert.equal(chip.textContent, "Low disk");
  assert.match(chip.getAttribute("title") ?? "", /5(\.0)? GB free \(5%\)/);
});

test("enough free disk, or an offline Computer, shows no low-disk chip", () => {
  renderRow(computer({ diskStatus: { availableBytes: 50 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 } }), null);
  assert.ok(!screen.queryByTestId("computer-disk-low-computer-1"));
  cleanup();
  renderRow(computer({ status: "offline", diskStatus: { availableBytes: 1, totalBytes: 100 } }), null);
  assert.ok(!screen.queryByTestId("computer-disk-low-computer-1"));
});
