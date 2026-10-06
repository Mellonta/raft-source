import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import MachineDetailPanel from "../src/components/machine/MachineDetailPanel";
import { useAgentStore } from "../src/store/agentStore";
import { useAppearanceStore } from "../src/store/appearanceStore";
import { useMachineStore } from "../src/store/machineStore";
import type { Machine } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { renderWithIntl } from "./helpers/intl";

// artin 2026-09-27 (#proj-frontend:5ac4184d): the agents listed on a Computer
// page carried the runtime only; the model belongs beside it. The Computer
// page is an admin surface, so this display is intentionally independent of
// the chat-side "Show agent model" preference.
const initialAgentState = useAgentStore.getState();
const initialAppearanceState = useAppearanceStore.getState();
const initialMachineState = useMachineStore.getState();
const initialServerState = useServerStore.getState();

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
  createdAt: "2026-09-01T00:00:00.000Z",
};

const machine: Machine = {
  id: "computer-1",
  name: "Model Mac",
  description: null,
  status: "online",
  statusVersion: 1,
  apiKeyPrefix: null,
  runtimes: [],
  hostname: "model-mac.local",
  os: "darwin",
  daemonVersion: "1.0.0",
  isComputer: true,
  computerAttachedByCurrentUser: true,
  computerVersion: "1.0.0",
  computerUpgradeAvailable: false,
  lastHeartbeat: null,
  createdAt: "2026-09-01T00:00:00.000Z",
};

function renderMachine() {
  useServerStore.setState({ current: server, members: [] });
  useAgentStore.setState({
    agents: [
      {
        id: "agent-1",
        name: "builder",
        displayName: "Builder",
        status: "active",
        machineId: "computer-1",
        runtime: "codex",
        model: "gpt-5-codex",
      },
    ],
  } as never);
  useMachineStore.setState({ computerOperationProgress: {} });

  return renderWithIntl(
    <MemoryRouter initialEntries={[`/s/acme/settings/computers/${machine.id}`]}>
      <MachineDetailPanel machine={machine} workspaceEmbedded />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  useAgentStore.setState(initialAgentState, true);
  useAppearanceStore.setState(initialAppearanceState, true);
  useMachineStore.setState(initialMachineState, true);
  useServerStore.setState(initialServerState, true);
});

test("the agents list on a Computer page shows the model beside the runtime", () => {
  renderMachine();
  assert.ok(screen.getByText("Codex CLI · GPT-5 Codex"));
});

test("the Computer page keeps the model visible even when the chat-side model preference is off", () => {
  useAppearanceStore.setState({ showAgentModelName: false });
  renderMachine();
  assert.ok(screen.getByText("Codex CLI · GPT-5 Codex"));
});
