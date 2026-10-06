import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router-dom";

import HandoffCreateFlow from "../src/components/handoff/HandoffCreateFlow";
import { pickLocalOnlineMachine } from "../src/components/handoff/handoffSessions";
import { TestIntlProvider } from "./helpers/intl";
import { useAgentStore } from "../src/store/agentStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMessageStore } from "../src/store/messageStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";

// Since task #104 the flow renders INSIDE Create Agent (no rail page); the
// behaviours below are unchanged and now guard the embedded component.
// Behavior teeth for the #7580 review findings (@Desktop-Reviewer专家):
//  - the createAgent payload must pin the session's own runtime (codex→codex),
//  - a briefing failure must NOT create a second agent on retry,
//  - a late excerpt for a previously-selected session must not contaminate the
//    currently-open wizard's preview,
//  - the local-machine pick must require authoritative id or UNIQUE hostname,
//    online only — duplicate hostnames or offline rows disable creation.

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
});

const CLAUDE_SESSION = {
  tool: "claude-code" as const,
  sessionId: "s-claude",
  cwd: "/Users/me/proj-a",
  model: "claude-fable-5",
  title: "claude session A",
  lastActiveAt: Date.now() - 60_000,
  sizeBytes: 100,
  transcriptPath: "/home/.claude/projects/-p/a.jsonl",
  activeRecently: false,
};

const CODEX_SESSION = {
  ...CLAUDE_SESSION,
  tool: "codex" as const,
  sessionId: "s-codex",
  cwd: "/Users/me/proj-b",
  model: "gpt-5",
  title: "codex session B",
  transcriptPath: "/home/.codex/sessions/b.jsonl",
};

interface BridgeOverrides {
  sessions?: Array<typeof CLAUDE_SESSION>;
  sessionExcerpt?: (input: { transcriptPath: string; tool: string }) => Promise<{ firstUserMessage: string | null; recentExcerpt: string }>;
  searchContent?: (query: string) => Promise<{ matches: Array<typeof CLAUDE_SESSION>; complete: boolean }>;
  machineIds?: string[];
  hostname?: string | null;
}

function installBridge(overrides: BridgeOverrides = {}) {
  const handoff: Record<string, unknown> = {
    listSessions: () => Promise.resolve(overrides.sessions ?? [CLAUDE_SESSION, CODEX_SESSION]),
    sessionExcerpt: overrides.sessionExcerpt
      ?? (() => Promise.resolve({ firstUserMessage: "opening", recentExcerpt: "recent" })),
  };
  // Only present when the test opts in — lets us exercise the older-bridge
  // (metadata-only) fallback path too.
  if (overrides.searchContent) handoff.searchContent = overrides.searchContent;
  (globalThis as { raftDesktop?: unknown }).raftDesktop = {
    isDesktop: true,
    handoff,
    computer: {
      getLocalInfo: () => Promise.resolve({ hostname: overrides.hostname === undefined ? "local-host" : overrides.hostname }),
      getStatus: () => Promise.resolve({ servers: (overrides.machineIds ?? []).map((machineId) => ({ machineId })) }),
    },
  };
}

function seedStores(overrides: {
  machines?: Array<{ id: string; hostname: string | null; status: "online" | "offline"; name?: string }>;
  createAgent?: (...args: unknown[]) => Promise<unknown>;
  sendMessage?: (...args: unknown[]) => Promise<unknown>;
} = {}) {
  useServerStore.setState({ current: { id: "srv-1", slug: "botiverse", name: "Botiverse" } as never });
  useMachineStore.setState({
    machines: (overrides.machines ?? [{ id: "m-1", hostname: "local-host", status: "online", name: "kabi" }]) as never,
  });
  const createAgent = overrides.createAgent
    ?? (() => Promise.resolve({ id: "agent-1", name: "a", displayName: "A" }));
  useAgentStore.setState({ createAgent: createAgent as never });
  useChannelStore.setState({ openDM: (() => Promise.resolve({ id: "dm-1" })) as never });
  const sendMessage = overrides.sendMessage ?? (() => Promise.resolve({}));
  useMessageStore.setState({ sendMessage: sendMessage as never });
}

function mount(onClose: () => void = () => {}, options: { strict?: boolean } = {}) {
  const tree = (
    <TestIntlProvider>
      <MemoryRouter>
        <HandoffCreateFlow onClose={onClose} />
      </MemoryRouter>
    </TestIntlProvider>
  );
  return render(options.strict ? <StrictMode>{tree}</StrictMode> : tree);
}

// Task #110: the list shows ONE tool at a time behind a segmented control, so a
// row is only reachable after its tool tab is active. Titles in these fixtures
// name their tool.
async function selectTool(view: ReturnType<typeof mount>, tool: "claude-code" | "codex") {
  const tab = await view.findByTestId(`handoff-tool-tab-${tool}`);
  fireEvent.click(tab);
}

function tabCounts(view: ReturnType<typeof mount>) {
  const read = (tool: "claude-code" | "codex") => Number((view.getByTestId(`handoff-tool-tab-${tool}`).textContent ?? "").replace(/\D+/g, ""));
  return { "claude-code": read("claude-code"), codex: read("codex") };
}

async function openWizardFor(view: ReturnType<typeof mount>, title: string) {
  await selectTool(view, title.toLowerCase().includes("codex") ? "codex" : "claude-code");
  await waitFor(() => {
    assert.ok(view.getAllByTestId("handoff-session-row").length > 0);
  });
  const row = view.getAllByTestId("handoff-session-row").find((r) => r.textContent?.includes(title));
  assert.ok(row, `session row for ${title}`);
  fireEvent.click(row);
  await waitFor(() => {
    assert.ok(view.getByTestId("handoff-agent-name-input"));
  });
}

test("content search: the query drives the main-process scan and the panel shows its summary matches", async () => {
  const A = { ...CLAUDE_SESSION, sessionId: "s-claude", cwd: "/Users/me/proj-a", title: "claude session A" };
  const B = { ...CODEX_SESSION, sessionId: "s-codex", cwd: "/Users/me/proj-b", title: "codex session B" };
  const queries: string[] = [];
  installBridge({
    sessions: [A, B],
    searchContent: (q) => {
      queries.push(q);
      if (q === "webhook") return Promise.resolve({ matches: [A], complete: true });
      return Promise.resolve({ matches: [], complete: true });
    },
  });
  seedStores();
  const view = mount();
  await waitFor(() => assert.deepEqual(tabCounts(view), { "claude-code": 1, codex: 1 }));
  assert.equal(view.queryAllByTestId("handoff-session-row").length, 1, "one tool's list at a time (Claude Code first)");
  const input = view.getByTestId("handoff-search-input");

  fireEvent.change(input, { target: { value: "webhook" } });
  await waitFor(() => {
    assert.equal(view.queryAllByTestId("handoff-session-row").length, 1);
    assert.ok(view.queryAllByTestId("handoff-session-row")[0].textContent?.includes("claude session A"));
  });
  assert.ok(queries.includes("webhook"), "the body query must reach the main-process scan");
});

test("content search: a hit OUTSIDE the initial listing is still shown (scan returns summaries)", async () => {
  // The initial list has only A; the scan finds C, which is NOT in the list.
  const A = { ...CLAUDE_SESSION, sessionId: "s-a", title: "session A in list" };
  const C = { ...CLAUDE_SESSION, sessionId: "s-c-old", transcriptPath: "/home/.claude/projects/-p/c.jsonl", title: "old session C off-list" };
  installBridge({
    sessions: [A],
    searchContent: (q) => Promise.resolve(q === "deepterm" ? { matches: [C], complete: true } : { matches: [], complete: true }),
  });
  seedStores();
  const view = mount();
  await waitFor(() => assert.equal(view.queryAllByTestId("handoff-session-row").length, 1));
  fireEvent.change(view.getByTestId("handoff-search-input"), { target: { value: "deepterm" } });
  await waitFor(() => {
    const rows = view.queryAllByTestId("handoff-session-row");
    assert.equal(rows.length, 1);
    assert.ok(rows[0].textContent?.includes("old session C off-list"), "an off-list scan hit must still be displayable");
  });
});

test("content search: a scan failure keeps confirmed metadata hits and warns (never blanks a matched id)", async () => {
  const A = { ...CLAUDE_SESSION, sessionId: "s-keep-me", title: "keepable session" };
  installBridge({
    sessions: [A],
    searchContent: () => Promise.reject(new Error("scan blew up")),
  });
  seedStores();
  const view = mount();
  await waitFor(() => assert.equal(view.queryAllByTestId("handoff-session-row").length, 1));
  // The query matches A's session id via metadata — it must survive the scan failure.
  fireEvent.change(view.getByTestId("handoff-search-input"), { target: { value: "s-keep-me" } });
  await waitFor(() => assert.ok(view.queryByTestId("handoff-search-incomplete"), "a failed scan must warn"));
  const rows = view.queryAllByTestId("handoff-session-row");
  assert.equal(rows.length, 1, "the confirmed metadata hit must not disappear when the scan fails");
  assert.ok(rows[0].textContent?.includes("keepable session"));
});

test("content search: an incomplete scan surfaces the partial-results notice, not a false empty", async () => {
  const A = { ...CLAUDE_SESSION, sessionId: "s-claude", title: "claude session A" };
  installBridge({
    sessions: [A],
    searchContent: () => Promise.resolve({ matches: [A], complete: false }),
  });
  seedStores();
  const view = mount();
  const input = view.getByTestId("handoff-search-input");
  fireEvent.change(input, { target: { value: "anything" } });
  await waitFor(() => assert.ok(view.queryByTestId("handoff-search-incomplete"), "incomplete scan must warn the user"));
});

test("without a content-search bridge, search falls back to metadata-only (id / directory / title) AND matching", async () => {
  const A = { ...CLAUDE_SESSION, sessionId: "s-claude", cwd: "/Users/me/proj-a", title: "claude session A" };
  const B = { ...CODEX_SESSION, sessionId: "s-codex", cwd: "/Users/me/proj-b", title: "codex session B" };
  installBridge({ sessions: [A, B] }); // no searchContent → older bridge
  seedStores();
  const view = mount();
  await waitFor(() => assert.deepEqual(tabCounts(view), { "claude-code": 1, codex: 1 }));
  const input = view.getByTestId("handoff-search-input");
  const rowText = () => view.queryAllByTestId("handoff-session-row").map((r) => r.textContent ?? "");

  // No tab was clicked, so the active tab follows the data: the Claude list
  // empties and the Codex list holds the hit → the view moves to Codex.
  fireEvent.change(input, { target: { value: "s-codex" } });
  await waitFor(() => assert.deepEqual(tabCounts(view), { "claude-code": 0, codex: 1 }));
  await waitFor(() => assert.equal(view.queryAllByTestId("handoff-session-row").length, 1));
  assert.ok(rowText().some((t) => t.includes("codex session B")));

  fireEvent.change(input, { target: { value: "proj-a" } });
  await waitFor(() => assert.equal(view.queryAllByTestId("handoff-session-row").length, 1));
  assert.ok(rowText().some((t) => t.includes("claude session A")));
});

test("codex sessions create codex-runtime agents; claude sessions create claude-runtime agents", async () => {
  const calls: Array<{ name: string; opts: Record<string, unknown> }> = [];
  installBridge();
  seedStores({
    createAgent: (name, opts) => {
      calls.push({ name: String(name), opts: opts as Record<string, unknown> });
      return Promise.resolve({ id: `agent-${calls.length}`, name: String(name), displayName: String(name) });
    },
  });
  const view = mount();

  await openWizardFor(view, "codex session B");
  await waitFor(() => assert.equal(view.getByTestId("handoff-confirm-button").hasAttribute("disabled"), false));
  fireEvent.click(view.getByTestId("handoff-confirm-button"));
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0].opts.runtime, "codex");
  assert.equal(calls[0].opts.model, "gpt-5");
  assert.equal(calls[0].opts.machineId, "m-1");

  await openWizardFor(view, "claude session A");
  await waitFor(() => assert.equal(view.getByTestId("handoff-confirm-button").hasAttribute("disabled"), false));
  fireEvent.click(view.getByTestId("handoff-confirm-button"));
  await waitFor(() => assert.equal(calls.length, 2));
  assert.equal(calls[1].opts.runtime, "claude");
  assert.equal(calls[1].opts.model, "claude-fable-5");
});

test("a briefing send failure does not create a second agent on retry, and the resend reuses one randomId", async () => {
  let createCalls = 0;
  const sendCalls: Array<unknown[]> = [];
  installBridge();
  seedStores({
    createAgent: () => {
      createCalls += 1;
      return Promise.resolve({ id: "agent-1", name: "a", displayName: "A" });
    },
    sendMessage: (...args: unknown[]) => {
      sendCalls.push(args);
      return sendCalls.length === 1 ? Promise.reject(new Error("boom")) : Promise.resolve({});
    },
  });
  const view = mount();
  await openWizardFor(view, "claude session A");
  await waitFor(() => assert.equal(view.getByTestId("handoff-confirm-button").hasAttribute("disabled"), false));

  fireEvent.click(view.getByTestId("handoff-confirm-button"));
  await waitFor(() => assert.equal(sendCalls.length, 1));
  await waitFor(() => assert.match(view.getByTestId("handoff-confirm-button").textContent ?? "", /Resend briefing/));

  fireEvent.click(view.getByTestId("handoff-confirm-button"));
  await waitFor(() => assert.equal(sendCalls.length, 2));
  assert.equal(createCalls, 1, "createAgent must run exactly once across the retry");
  // Positional randomId argument (channelId, content, attachmentIds, asTask, optimisticId, randomId).
  assert.ok(sendCalls[0][5], "first send carries a randomId");
  assert.equal(sendCalls[0][5], sendCalls[1][5], "retry reuses the same randomId for dedupe");
});

test("a late excerpt cannot contaminate the preview — across sessions AND on same-session reopen", async () => {
  // Per-CALL resolvers (not per-path): the reopen-same-session race needs two
  // independent in-flight requests for the SAME transcriptPath.
  const resolvers: Array<(v: { firstUserMessage: string | null; recentExcerpt: string }) => void> = [];
  installBridge({
    sessionExcerpt: () => new Promise((resolve) => { resolvers.push(resolve); }),
  });
  seedStores();
  const view = mount();

  // Cross-session: A pending → cancel → B; B resolves, then A resolves late.
  await openWizardFor(view, "claude session A");
  fireEvent.click(view.getByTestId("handoff-choose-another"));
  await openWizardFor(view, "codex session B");
  assert.equal(resolvers.length, 2);
  resolvers[1]({ firstUserMessage: "b-open", recentExcerpt: "B-RECENT" });
  await waitFor(() => assert.match(document.body.textContent ?? "", /B-RECENT/));
  resolvers[0]({ firstUserMessage: "a-open", recentExcerpt: "A-STALE" });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!(document.body.textContent ?? "").includes("A-STALE"), "stale A excerpt must be dropped");
  assert.match(document.body.textContent ?? "", /B-RECENT/);

  // Same-session reopen: open A → cancel → open A again; the SECOND request
  // resolves first, then the FIRST arrives late and must be discarded.
  fireEvent.click(view.getByTestId("handoff-choose-another"));
  await openWizardFor(view, "claude session A");
  fireEvent.click(view.getByTestId("handoff-choose-another"));
  await openWizardFor(view, "claude session A");
  assert.equal(resolvers.length, 4);
  resolvers[3]({ firstUserMessage: "a-open", recentExcerpt: "A-NEWEST" });
  await waitFor(() => assert.match(document.body.textContent ?? "", /A-NEWEST/));
  resolvers[2]({ firstUserMessage: "a-open", recentExcerpt: "A-FIRST-LATE" });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!(document.body.textContent ?? "").includes("A-FIRST-LATE"), "late first request must be dropped on reopen");
  assert.match(document.body.textContent ?? "", /A-NEWEST/);
});

test("duplicate hostnames without an authoritative machine id disable creation; the authoritative id wins when present", async () => {
  installBridge({ sessions: [CLAUDE_SESSION] });
  seedStores({
    machines: [
      { id: "m-old", hostname: "local-host", status: "offline" },
      { id: "m-new", hostname: "local-host", status: "online" },
    ],
  });
  const view = mount();
  await openWizardFor(view, "claude session A");
  await waitFor(() => {
    assert.equal(view.getByTestId("handoff-confirm-button").hasAttribute("disabled"), true);
  });
  cleanup();

  const calls: Array<Record<string, unknown>> = [];
  installBridge({ sessions: [CLAUDE_SESSION], machineIds: ["m-new"] });
  seedStores({
    machines: [
      { id: "m-old", hostname: "local-host", status: "offline" },
      { id: "m-new", hostname: "local-host", status: "online" },
    ],
    createAgent: (_name, opts) => {
      calls.push(opts as Record<string, unknown>);
      return Promise.resolve({ id: "agent-1", name: "a", displayName: "A" });
    },
  });
  const view2 = mount();
  await openWizardFor(view2, "claude session A");
  await waitFor(() => assert.equal(view2.getByTestId("handoff-confirm-button").hasAttribute("disabled"), false));
  fireEvent.click(view2.getByTestId("handoff-confirm-button"));
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0].machineId, "m-new");
});

test("pickLocalOnlineMachine: authoritative id beats hostname; offline or ambiguous rows yield null", () => {
  const online = { id: "m1", hostname: "h", status: "online" as const };
  const offline = { id: "m2", hostname: "h", status: "offline" as const };
  assert.equal(pickLocalOnlineMachine([offline, online], { hostname: null, machineIds: ["m1"] }), online);
  assert.equal(pickLocalOnlineMachine([offline], { hostname: null, machineIds: ["m2"] }), null);
  assert.equal(pickLocalOnlineMachine([online], { hostname: "h", machineIds: [] }), online);
  assert.equal(pickLocalOnlineMachine([offline, online], { hostname: "h", machineIds: [] }), null, "duplicate hostname is ambiguous");
  assert.equal(pickLocalOnlineMachine([{ ...online, status: "offline" as const }], { hostname: "h", machineIds: [] }), null);
});

test("a successful handoff closes the hosting Create Agent dialog (task #104) after the briefing is sent", async () => {
  let closed = 0;
  installBridge();
  seedStores();
  const view = mount(() => { closed += 1; });
  await openWizardFor(view, "claude session A");
  await waitFor(() => assert.equal(view.getByTestId("handoff-confirm-button").hasAttribute("disabled"), false));
  fireEvent.click(view.getByTestId("handoff-confirm-button"));
  await waitFor(() => assert.equal(closed, 1));
});

test("Choose another session returns to the picker without closing the dialog; Cancel closes it", async () => {
  let closed = 0;
  installBridge();
  seedStores();
  const view = mount(() => { closed += 1; });
  await openWizardFor(view, "claude session A");
  fireEvent.click(view.getByTestId("handoff-choose-another"));
  await waitFor(() => assert.ok(view.getByTestId("handoff-session-picker")));
  assert.equal(closed, 0);
  fireEvent.click(view.getByText("Cancel"));
  assert.equal(closed, 1);
});

test("a REAL unmount mid-create leaves the late continuation inert (no onClose / navigate after unmount)", async () => {
  let resolveCreate!: (agent: unknown) => void;
  let closed = 0;
  let sends = 0;
  installBridge();
  seedStores({
    createAgent: () => new Promise((resolve) => { resolveCreate = resolve; }),
    sendMessage: () => { sends += 1; return Promise.resolve({}); },
  });
  const view = mount(() => { closed += 1; });
  await openWizardFor(view, "claude session A");
  await waitFor(() => assert.equal(view.getByTestId("handoff-confirm-button").hasAttribute("disabled"), false));
  fireEvent.click(view.getByTestId("handoff-confirm-button"));
  view.unmount();
  resolveCreate({ id: "agent-1", name: "a", displayName: "A" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(closed, 0, "a continuation after unmount must not close the host");
  assert.equal(sends, 0, "nor send the briefing on behalf of a flow that is gone");
});

test("under StrictMode (effect replay) the flow still completes and closes the host", async () => {
  let closed = 0;
  installBridge();
  seedStores();
  const view = mount(() => { closed += 1; }, { strict: true });
  await openWizardFor(view, "claude session A");
  await waitFor(() => assert.equal(view.getByTestId("handoff-confirm-button").hasAttribute("disabled"), false));
  fireEvent.click(view.getByTestId("handoff-confirm-button"));
  await waitFor(() => assert.equal(closed, 1));
});

test("tool toggle (task #110): one list at a time, counts per tool, click switches; a data-only Codex box opens on Codex", async () => {
  installBridge();
  seedStores();
  const view = mount();
  await waitFor(() => assert.deepEqual(tabCounts(view), { "claude-code": 1, codex: 1 }));
  assert.ok(view.getByTestId("handoff-tool-list-claude-code"), "Claude Code is the default when it has sessions");
  assert.equal(view.getAllByTestId("handoff-session-row")[0].textContent?.includes("claude session A"), true);

  await selectTool(view, "codex");
  await waitFor(() => assert.ok(view.getByTestId("handoff-tool-list-codex")));
  assert.equal(view.getAllByTestId("handoff-session-row").length, 1);
  assert.equal(view.getAllByTestId("handoff-session-row")[0].textContent?.includes("codex session B"), true);
  // An explicit choice sticks even when a search empties that tab: the empty
  // state for the chosen tool is shown, not a silent jump to the other one.
  fireEvent.change(view.getByTestId("handoff-search-input"), { target: { value: "proj-a" } });
  await waitFor(() => assert.deepEqual(tabCounts(view), { "claude-code": 1, codex: 0 }));
  assert.ok(view.getByTestId("handoff-tool-list-codex"));
  assert.equal(view.queryAllByTestId("handoff-session-row").length, 0);
  cleanup();

  installBridge({ sessions: [CODEX_SESSION] });
  seedStores();
  const view2 = mount();
  await waitFor(() => assert.deepEqual(tabCounts(view2), { "claude-code": 0, codex: 1 }));
  assert.ok(view2.getByTestId("handoff-tool-list-codex"), "with only Codex sessions the Codex tab is active by default");
});

test("review of #8205: clicking the ALREADY-active tab counts as an explicit choice — a later search that only hits the other tool does not move the view", async () => {
  installBridge();
  seedStores();
  const view = mount();
  await waitFor(() => assert.deepEqual(tabCounts(view), { "claude-code": 1, codex: 1 }));
  assert.ok(view.getByTestId("handoff-tool-list-claude-code"), "Claude is the data-driven default");
  // Same-item activation: RadioGroup fires no value change here, so this must
  // be recorded by the item's own click/key handlers.
  fireEvent.click(view.getByTestId("handoff-tool-tab-claude-code"));
  fireEvent.change(view.getByTestId("handoff-search-input"), { target: { value: "proj-b" } });
  await waitFor(() => assert.deepEqual(tabCounts(view), { "claude-code": 0, codex: 1 }));
  assert.ok(view.getByTestId("handoff-tool-list-claude-code"), "stays on Claude (empty state), does not jump to Codex");
  assert.equal(view.queryAllByTestId("handoff-session-row").length, 0);
  cleanup();

  // Keyboard activation of the current item (Enter / Space) pins it too.
  installBridge();
  seedStores();
  const view2 = mount();
  await waitFor(() => assert.deepEqual(tabCounts(view2), { "claude-code": 1, codex: 1 }));
  fireEvent.keyDown(view2.getByTestId("handoff-tool-tab-claude-code"), { key: " " });
  fireEvent.change(view2.getByTestId("handoff-search-input"), { target: { value: "proj-b" } });
  await waitFor(() => assert.deepEqual(tabCounts(view2), { "claude-code": 0, codex: 1 }));
  assert.ok(view2.getByTestId("handoff-tool-list-claude-code"));
});

test("review of #8205: list rows use semantic theme tokens (no unconditional black text/border/bg — Elegant dark panels are dark)", async () => {
  installBridge({ sessions: [{ ...CLAUDE_SESSION, activeRecently: true }] });
  seedStores();
  const view = mount();
  const row = (await view.findAllByTestId("handoff-session-row"))[0];
  const offenders = Array.from(row.querySelectorAll<HTMLElement>("*")).concat(row)
    .flatMap((el) => Array.from(el.classList))
    .filter((cls) => /^(text|border|bg)-black(\/\d+)?$/.test(cls));
  assert.deepEqual(offenders, [], "brutal-only colours must be behind the theme-brutal: variant");
});
