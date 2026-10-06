import assert from "node:assert/strict";
import "./helpers/domSetup";
import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import HandoffDialog from "../src/components/handoff/HandoffDialog";
import { TestIntlProvider } from "./helpers/intl";
import { useAgentStore } from "../src/store/agentStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMessageStore } from "../src/store/messageStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";

// Task #110 (@WAWQAQ): "Take over a local session" is its own dialog, opened
// from the sidebar's Agents "+" menu — no longer a mode inside Create Agent.
// The host owns the close constraint (carried over from the #8024 review):
// while a handoff create is in flight, X / Esc / Cancel must not tear the flow
// down; a successful handoff closes the dialog exactly once.

const originalAgentState = useAgentStore.getState();
const originalChannelState = useChannelStore.getState();
const originalMessageState = useMessageStore.getState();
const originalMachineState = useMachineStore.getState();
const originalServerState = useServerStore.getState();

afterEach(() => {
  cleanup();
  useAgentStore.setState(originalAgentState, true);
  useChannelStore.setState(originalChannelState, true);
  useMessageStore.setState(originalMessageState, true);
  useMachineStore.setState(originalMachineState, true);
  useServerStore.setState(originalServerState, true);
  delete (globalThis as { raftDesktop?: unknown }).raftDesktop;
  delete (window as { raftDesktop?: unknown }).raftDesktop;
});

const SESSION = {
  tool: "claude-code" as const,
  sessionId: "s-1",
  cwd: "/Users/me/proj",
  model: "claude-fable-5",
  title: "claude session",
  lastActiveAt: Date.now() - 60_000,
  sizeBytes: 1,
  transcriptPath: "/home/.claude/projects/-p/a.jsonl",
  activeRecently: false,
};

function installBridge() {
  const value = {
    isDesktop: true,
    handoff: {
      listSessions: () => Promise.resolve([SESSION]),
      sessionExcerpt: () => Promise.resolve({ firstUserMessage: "opening", recentExcerpt: "recent" }),
    },
    computer: {
      getLocalInfo: () => Promise.resolve({ hostname: "local-host" }),
      getStatus: () => Promise.resolve({ servers: [{ machineId: "m-1" }] }),
    },
  };
  (globalThis as { raftDesktop?: unknown }).raftDesktop = value;
  (window as { raftDesktop?: unknown }).raftDesktop = value;
}

function seedStores(overrides: {
  createAgent?: (...args: unknown[]) => Promise<unknown>;
  sendMessage?: (...args: unknown[]) => Promise<unknown>;
} = {}) {
  useServerStore.setState({ current: { id: "srv-1", slug: "botiverse", name: "Botiverse" } as never });
  useMachineStore.setState({ machines: [{ id: "m-1", hostname: "local-host", status: "online", name: "kabi" }] as never });
  useAgentStore.setState({ createAgent: (overrides.createAgent ?? (() => Promise.resolve({ id: "agent-1", name: "a", displayName: "A" }))) as never });
  useChannelStore.setState({ openDM: (() => Promise.resolve({ id: "dm-1" })) as never });
  useMessageStore.setState({ sendMessage: (overrides.sendMessage ?? (() => Promise.resolve({}))) as never });
}

function mount(onClose: () => void = () => {}, options: { strict?: boolean } = {}) {
  const tree = (
    <TestIntlProvider>
      <MemoryRouter>
        <HandoffDialog onClose={onClose} />
      </MemoryRouter>
    </TestIntlProvider>
  );
  return render(options.strict ? <StrictMode>{tree}</StrictMode> : tree);
}

async function selectSessionAndConfirm() {
  fireEvent.click((await screen.findAllByTestId("handoff-session-row"))[0]);
  await waitFor(() => assert.equal(screen.getByTestId("handoff-confirm-button").hasAttribute("disabled"), false));
  fireEvent.click(screen.getByTestId("handoff-confirm-button"));
}

test("the dialog has its own title and subtitle and hosts the session picker", async () => {
  installBridge();
  seedStores();
  mount();
  assert.ok(screen.getByTestId("handoff-dialog"));
  assert.ok(screen.getByText("Take over a local session"));
  assert.match(document.body.textContent ?? "", /Hand what Claude Code or Codex is doing on this computer/);
  await screen.findByTestId("handoff-session-picker");
});

test("close is refused while a handoff create is in flight, then the success closes the dialog exactly once", async () => {
  let resolveCreate!: (agent: unknown) => void;
  let closed = 0;
  installBridge();
  seedStores({ createAgent: () => new Promise((resolve) => { resolveCreate = resolve; }) });
  mount(() => { closed += 1; });
  await selectSessionAndConfirm();

  // Host X (DialogCard) and Escape are both routed through the guarded close.
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.keyDown(document, { key: "Escape" });
  assert.equal(closed, 0, "must not close mid-create");

  resolveCreate({ id: "agent-1", name: "a", displayName: "A" });
  await waitFor(() => assert.equal(closed, 1));
});

test("when idle (picker or selected form), Cancel and the host X close normally", async () => {
  let closed = 0;
  installBridge();
  seedStores();
  mount(() => { closed += 1; });
  await screen.findByTestId("handoff-session-picker");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  assert.equal(closed, 1);
});

test("under StrictMode a handoff with a briefing retry still completes and closes", async () => {
  let closed = 0;
  let sends = 0;
  installBridge();
  seedStores({ sendMessage: () => { sends += 1; return sends === 1 ? Promise.reject(new Error("boom")) : Promise.resolve({}); } });
  mount(() => { closed += 1; }, { strict: true });
  await selectSessionAndConfirm();
  await waitFor(() => assert.match(screen.getByTestId("handoff-confirm-button").textContent ?? "", /Resend briefing/));
  // Retry pending: the host may close (explicit action), but we resend instead.
  fireEvent.click(screen.getByTestId("handoff-confirm-button"));
  await waitFor(() => assert.equal(closed, 1));
  assert.equal(sends, 2);
});
