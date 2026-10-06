import "./helpers/domSetup";

import assert from "node:assert/strict";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ReportIssueDialog from "../src/components/agent/ReportIssueDialog";
import { en as enMessages } from "../src/i18n/messages/en";
import type { Agent } from "../src/store/agentStore";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useMachineStore } from "../src/store/machineStore";
import type { Machine } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

// task #279 — the runner-log tail defaults ON for the reporter's own machine,
// including when ownership becomes known AFTER the dialog mounted, and never
// overrides a choice the user already made.

const label = enMessages["agent.reportIssue.includeMachineLogTail"] as string;
// The label element also contains the disclosure line, so match on its start.
const byLabel = (content: string) => content.startsWith(label);

// RUI Checkbox is a Base UI span[role=checkbox] + hidden native input, so
// getByLabelText would double-match; query the span by role and read state
// from aria-checked.
function box() {
  return screen.getByRole("checkbox", { name: byLabel });
}

function isChecked(element: HTMLElement) {
  return element.getAttribute("aria-checked") === "true";
}

const agent: Agent = {
  id: "agent-1", serverId: "server-1", name: "helper", displayName: "Helper", avatarUrl: null, description: "A test agent",
  status: "idle", model: "test-model", runtime: "codex", serverRole: "member", reasoningEffort: null, executionMode: "byoc",
  envVars: null, machineId: "machine-1", creatorType: "user", creatorId: "user-1", creator: null, createdAgents: [], deletedAt: null,
  createdAt: "2026-08-12T00:00:00.000Z",
};
const machine: Machine = {
  id: "machine-1", name: "Test computer", description: null, status: "online", statusVersion: 1, apiKeyPrefix: null, runtimes: ["codex"],
  hostname: "test.local", os: "darwin", daemonVersion: "1.0.27", lastHeartbeat: "2026-08-12T00:00:00.000Z", createdAt: "2026-08-12T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

function renderDialog(machines: Machine[]) {
  useAuthStore.setState({ user: { id: "user-1", email: "reporter@example.test", name: "reporter", displayName: "Reporter" } } as never);
  useServerStore.setState({ current: { id: "server-1", name: "Test server", slug: "test-server" } } as never);
  useMachineStore.setState({ machines } as never);
  useAgentStore.setState({ getActivityLog: () => [], getTrajectoryLog: () => [] } as never);
  render(
    <TestIntlProvider locale="en">
      <MemoryRouter>
        <ReportIssueDialog agent={agent} onClose={() => undefined} feedbackExportUrl="https://feedback.example.test" />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

test("ownership known at mount → runner-log tail is on by default", () => {
  renderDialog([{ ...machine, computerAttachedByCurrentUser: true }]);
  assert.equal(isChecked(box()), true);
});

test("ownership arriving after mount turns the default on once; a user untick is never overridden by later store updates", async () => {
  renderDialog([]);
  assert.equal(screen.queryByRole("checkbox", { name: byLabel }), null, "no box until the machine is known to be the reporter's own");

  await act(async () => { useMachineStore.setState({ machines: [{ ...machine, computerAttachedByCurrentUser: true }] } as never); });
  const machineLogBox = box();
  assert.equal(isChecked(machineLogBox), true, "first time ownership is known, the default applies");

  fireEvent.click(machineLogBox);
  assert.equal(isChecked(box()), false);

  await act(async () => { useMachineStore.setState({ machines: [{ ...machine, computerAttachedByCurrentUser: true, statusVersion: 2 }] } as never); });
  assert.equal(isChecked(box()), false, "a later store update must not re-tick a box the user cleared");
});

test("a machine that is not the reporter's own never shows the box, so nothing is sent", () => {
  renderDialog([{ ...machine, computerAttachedByCurrentUser: false }]);
  assert.equal(screen.queryByRole("checkbox", { name: byLabel }), null);
});
