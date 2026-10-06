import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import api from "../src/api/client";
import { AgentConnections } from "../src/components/agent/AgentConnections";
import AgentConnectionCallbackPage, { describeAgentConnectionCallback } from "../src/pages/AgentConnectionCallbackPage";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SERVER = "33333333-3333-4333-8333-333333333333";
const AGENT = "44444444-4444-4444-8444-444444444444";

const initialAuthState = useAuthStore.getState();

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAuthStore.setState(initialAuthState, true);
  useServerStore.setState({ current: null, servers: [], members: [] } as never);
});

function callbackSearch(params: Record<string, string>) {
  return `?${new URLSearchParams({ connection: "github", serverId: SERVER, agentId: AGENT, ...params })}`;
}

function renderCallback(search: string) {
  useAuthStore.setState({ user: { id: ME } } as never);
  useServerStore.setState({ current: null, servers: [{ id: SERVER, slug: "acme", name: "Acme" }], members: [] } as never);
  return render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={[`/connections/callback${search}`]}>
        <Routes>
          <Route path="/connections/callback" element={<AgentConnectionCallbackPage />} />
        </Routes>
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

test("the callback view binds the flow to the signed-in user", () => {
  assert.equal(describeAgentConnectionCallback(callbackSearch({ status: "pending", pending: "p1", by: OTHER }), ME).kind, "foreign");
  assert.equal(describeAgentConnectionCallback(callbackSearch({ status: "pending", pending: "p1" }), ME).kind, "foreign", "missing by");
  assert.equal(describeAgentConnectionCallback(callbackSearch({ status: "pending", pending: "p1", by: ME }), null).kind, "foreign", "signed out");
  assert.deepEqual(describeAgentConnectionCallback(callbackSearch({ status: "pending", pending: "p1", by: ME }), ME), {
    kind: "pending", pending: "p1", provider: "github", serverId: SERVER, agentId: AGENT,
  });
  assert.equal(describeAgentConnectionCallback(callbackSearch({ status: "pending", by: ME }), ME).kind, "failed", "pending without id");
  assert.equal(describeAgentConnectionCallback(callbackSearch({ status: "connected", by: ME }), ME).kind, "failed", "no unconfirmed success");
  assert.equal(describeAgentConnectionCallback(callbackSearch({ status: "denied", by: ME }), ME).kind, "denied");
  assert.equal(describeAgentConnectionCallback("?connection=gitlab&status=pending", ME).kind, "invalid");
  for (const id of Object.keys(en).filter((key) => key.startsWith("agent.detail.connections.") || key.startsWith("pages.agentConnectionCallback."))) {
    assert.ok(zh[id], `${id} has a zh-cn translation`);
  }
});

test("a flow started by another user is never confirmed and advises disconnect if the agent is connected", async () => {
  const post = vi.spyOn(api, "post").mockImplementation(async () => ({ data: {} }) as never);
  const get = vi.spyOn(api, "get").mockImplementation(async () => ({
    data: { provider: "github", supported: true, connected: true, account: "octocat", connectedAt: null, connectedBy: null, scopes: [] },
  }) as never);
  renderCallback(callbackSearch({ status: "pending", pending: "p1", by: OTHER }));
  assert.equal(screen.getByTestId("agent-connection-callback-message").textContent, en["pages.agentConnectionCallback.foreign"]);
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-callback-disconnect-advice")));
  assert.equal(post.mock.calls.length, 0, "no confirm call for someone else's flow");
  assert.equal(get.mock.calls[0]?.[0], `/agents/${AGENT}/connections/github`);
});

test("the initiating user confirms the pending id once, for the agent's server", async () => {
  const post = vi.spyOn(api, "post").mockImplementation(async () => ({
    data: { provider: "github", supported: true, connected: true, account: "octocat", connectedAt: null, connectedBy: null, scopes: [] },
  }) as never);
  renderCallback(callbackSearch({ status: "pending", pending: "p1", by: ME }));
  await waitFor(() => assert.match(screen.getByTestId("agent-connection-callback-message").textContent ?? "", /octocat/));
  assert.equal(post.mock.calls.length, 1);
  const [path, body, config] = post.mock.calls[0]!;
  assert.equal(path, `/agents/${AGENT}/connections/github/confirm`);
  assert.deepEqual(body, { pending: "p1" });
  assert.deepEqual((config as { headers: Record<string, string> }).headers, { "X-Server-Id": SERVER });
  assert.ok(screen.getByRole("link", { name: en["pages.agentConnectionCallback.backToAgent"] }).getAttribute("href")?.endsWith(`/s/acme/agent/${AGENT}`));
});

test("an expired or used pending id asks the user to start again", async () => {
  vi.spyOn(api, "post").mockImplementation(async () => { throw Object.assign(new Error("404"), { response: { status: 404 } }); });
  renderCallback(callbackSearch({ status: "pending", pending: "p1", by: ME }));
  await waitFor(() => assert.equal(screen.getByTestId("agent-connection-callback-message").textContent, en["pages.agentConnectionCallback.expired"]));
});

test("the Connections section shows scopes before redirecting and maps private access", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({
    data: { provider: "github", supported: true, connected: false, account: null, connectedAt: null, connectedBy: null, scopes: [] },
  }) as never);
  const post = vi.spyOn(api, "post").mockImplementation(async () => ({
    data: { url: "https://github.com/login/oauth/authorize?x=1", expiresAt: "2026-09-29T00:10:00.000Z", scopes: ["repo"] },
  }) as never);
  render(<TestIntlProvider><AgentConnections agentId={AGENT} /></TestIntlProvider>);
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github")));
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: en["agent.detail.connections.connect"] }));
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-pending")));
  assert.deepEqual(post.mock.calls[0]?.slice(0, 2), [`/agents/${AGENT}/connections/github`, { access: "private" }]);
  assert.match(screen.getByTestId("agent-connection-github-pending").textContent ?? "", /repo/);
});

test("the Connections section stays hidden when the provider does not support connections", async () => {
  const get = vi.spyOn(api, "get").mockImplementation(async () => ({ data: { provider: "github", supported: false } }) as never);
  render(<TestIntlProvider><AgentConnections agentId={AGENT} /></TestIntlProvider>);
  await waitFor(() => assert.equal(get.mock.calls.length, 1));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(screen.queryByTestId("agent-connections") === null);
});

const REASON = "Agent has no github plugin mount; add exactly one.";
function refusal(status: number) {
  return Object.assign(new Error(String(status)), {
    response: { status, data: { code: "agent_connection_provider_refused", providerCode: "github_mount_missing", providerMessage: REASON } },
  });
}

test("Connect shows the provider's refusal reason instead of a generic failure", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({
    data: { provider: "github", supported: true, connected: false, account: null, connectedAt: null, connectedBy: null, scopes: [] },
  }) as never);
  vi.spyOn(api, "post").mockImplementation(async () => { throw refusal(409); });
  render(<TestIntlProvider><AgentConnections agentId={AGENT} /></TestIntlProvider>);
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github")));
  fireEvent.click(screen.getByRole("button", { name: en["agent.detail.connections.connect"] }));
  await waitFor(() => assert.match(screen.getByTestId("agent-connection-github-error").textContent ?? "", /no github plugin mount/));
});

test("the callback page shows the provider's refusal reason after confirm", async () => {
  vi.spyOn(api, "post").mockImplementation(async () => { throw refusal(409); });
  renderCallback(callbackSearch({ status: "pending", pending: "p1", by: ME }));
  await waitFor(() => assert.match(screen.getByTestId("agent-connection-callback-message").textContent ?? "", /no github plugin mount/));
});

function agentMissing() {
  return Object.assign(new Error("409"), {
    response: { status: 409, data: { code: "agent_connection_agent_missing_at_provider", providerMessage: "no provisioned agent made from Raft agent x" } },
  });
}

test("the Connections section warns (instead of hiding) when the agent no longer exists at its provider", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => { throw agentMissing(); });
  render(<TestIntlProvider><AgentConnections agentId={AGENT} /></TestIntlProvider>);
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connections")));
  assert.equal(screen.getByTestId("agent-connections-agent-missing").textContent, en["agent.detail.connections.agentMissingAtProvider"]);
  assert.ok(screen.queryByTestId("agent-connection-github") === null, "no Connect action");
});

test("Connect switches to the missing-agent warning when the provider no longer knows the agent", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({
    data: { provider: "github", supported: true, connected: false, account: null, connectedAt: null, connectedBy: null, scopes: [] },
  }) as never);
  vi.spyOn(api, "post").mockImplementation(async () => { throw agentMissing(); });
  render(<TestIntlProvider><AgentConnections agentId={AGENT} /></TestIntlProvider>);
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github")));
  fireEvent.click(screen.getByRole("button", { name: en["agent.detail.connections.connect"] }));
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connections-agent-missing")));
  assert.ok(screen.queryByTestId("agent-connection-github") === null);
});

test("other 4xx statuses still hide the Connections section", async () => {
  const get = vi.spyOn(api, "get").mockImplementation(async () => {
    throw Object.assign(new Error("409"), { response: { status: 409, data: { code: "agent_connection_agent_not_active" } } });
  });
  render(<TestIntlProvider><AgentConnections agentId={AGENT} /></TestIntlProvider>);
  await waitFor(() => assert.equal(get.mock.calls.length, 1));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(screen.queryByTestId("agent-connections") === null);
});

function connector(id: string, account: string, creatorName: string | null, canManage: boolean, current = false) {
  return { id, account, createdAt: "2026-09-29T00:00:00.000Z", creator: { id: `${id}-user`, name: creatorName, displayName: creatorName }, current, canManage };
}

function connectedStatus(connectors: ReturnType<typeof connector>[], connectorId = "ctr_mine") {
  return {
    provider: "github", supported: true, connected: true, account: "octocat", connectedAt: null, connectedBy: null, scopes: [],
    connectorId, connectors,
  };
}

async function openConnectorMenu() {
  const trigger = screen.getByRole("combobox", { name: en["agent.detail.connections.useConnection"] });
  fireEvent.click(trigger);
  return trigger;
}

test("the connector dropdown names the current creator, disables connectors the caller cannot assign and switches with PUT", async () => {
  let status = connectedStatus([
    connector("ctr_mine", "octocat", "alice", true, true),
    connector("ctr_theirs", "hubot", "bob", false),
    connector("ctr_team", "monalisa", "carol", true),
  ]);
  const get = vi.spyOn(api, "get").mockImplementation(async () => ({ data: status }) as never);
  const put = vi.spyOn(api, "put").mockImplementation(async () => {
    status = { ...status, connectorId: "ctr_team" };
    return { data: status } as never;
  });
  render(<TestIntlProvider><AgentConnections agentId={AGENT} /></TestIntlProvider>);
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-connectors")));
  assert.match(screen.getByTestId("agent-connection-github-status").textContent ?? "", /Uses @alice's GitHub \(octocat\)/);

  await openConnectorMenu();
  const forbidden = await screen.findByRole("option", { name: /hubot · created by @bob/ });
  assert.equal(forbidden.getAttribute("aria-disabled"), "true");
  assert.equal(forbidden.getAttribute("title"), en["agent.detail.connections.connectorForbidden"]);
  fireEvent.pointerDown(forbidden);
  fireEvent.click(forbidden);
  assert.equal(put.mock.calls.length, 0, "a connector the caller cannot assign is never sent");

  const allowed = await screen.findByRole("option", { name: /monalisa · created by @carol/ });
  fireEvent.pointerDown(allowed);
  fireEvent.click(allowed);
  await waitFor(() => assert.equal(put.mock.calls.length, 1));
  assert.deepEqual(put.mock.calls[0]?.slice(0, 2), [`/agents/${AGENT}/connections/github`, { connectorId: "ctr_team" }]);
  await waitFor(() => assert.ok(get.mock.calls.length >= 2, "status reloads after switching"));
});

test("Disconnect this connection is offered only to the connector's creator or an admin and warns about every agent", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: connectedStatus([connector("ctr_mine", "octocat", "alice", false, true)]) }) as never);
  const { unmount } = render(<TestIntlProvider><AgentConnections agentId={AGENT} /></TestIntlProvider>);
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-connectors")));
  assert.ok(screen.getByRole("button", { name: en["agent.detail.connections.detach"] }), "detach stays available");
  assert.ok(screen.queryByRole("button", { name: en["agent.detail.connections.disconnectConnector"] }) === null);
  unmount();
  vi.restoreAllMocks();

  vi.spyOn(api, "get").mockImplementation(async () => ({ data: connectedStatus([connector("ctr_mine", "octocat", "alice", true, true)]) }) as never);
  const del = vi.spyOn(api, "delete").mockImplementation(async () => ({ data: null }) as never);
  render(<TestIntlProvider><AgentConnections agentId={AGENT} /></TestIntlProvider>);
  await waitFor(() => assert.ok(screen.queryByRole("button", { name: en["agent.detail.connections.disconnectConnector"] })));
  fireEvent.click(screen.getByRole("button", { name: en["agent.detail.connections.disconnectConnector"] }));
  await waitFor(() => assert.ok(screen.queryByText(/every agent on this server that uses it/)));
  fireEvent.click(screen.getByTestId("agent-connection-disconnect-connector-confirm"));
  await waitFor(() => assert.equal(del.mock.calls.length, 1));
  assert.equal(del.mock.calls[0]?.[0], `/agents/${AGENT}/connections/github/connectors/ctr_mine`);
});

test("Remove from this agent detaches only this agent", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: connectedStatus([connector("ctr_mine", "octocat", "alice", false, true)]) }) as never);
  const del = vi.spyOn(api, "delete").mockImplementation(async () => ({ data: null }) as never);
  render(<TestIntlProvider><AgentConnections agentId={AGENT} /></TestIntlProvider>);
  await waitFor(() => assert.ok(screen.queryByRole("button", { name: en["agent.detail.connections.detach"] })));
  fireEvent.click(screen.getByRole("button", { name: en["agent.detail.connections.detach"] }));
  await waitFor(() => assert.ok(screen.queryByText(/stays available to other agents/)));
  const confirmButtons = screen.getAllByRole("button", { name: en["agent.detail.connections.detach"] });
  fireEvent.click(confirmButtons.at(-1)!);
  await waitFor(() => assert.equal(del.mock.calls.length, 1));
  assert.equal(del.mock.calls[0]?.[0], `/agents/${AGENT}/connections/github`);
});

test("a partially completed connector disconnect is not a success and offers a retry of the same call", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: connectedStatus([connector("ctr_mine", "octocat", "alice", true, true)]) }) as never);
  let calls = 0;
  const del = vi.spyOn(api, "delete").mockImplementation(async () => {
    calls += 1;
    if (calls === 1) {
      throw Object.assign(new Error("502"), { response: { status: 502, data: { code: "agent_connection_connector_disconnect_partial", failedCount: 2 } } });
    }
    return { data: null } as never;
  });
  render(<TestIntlProvider><AgentConnections agentId={AGENT} /></TestIntlProvider>);
  await waitFor(() => assert.ok(screen.queryByRole("button", { name: en["agent.detail.connections.disconnectConnector"] })));
  fireEvent.click(screen.getByRole("button", { name: en["agent.detail.connections.disconnectConnector"] }));
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-disconnect-connector-confirm")));
  fireEvent.click(screen.getByTestId("agent-connection-disconnect-connector-confirm"));
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-disconnect-partial")));
  assert.match(screen.getByTestId("agent-connection-disconnect-partial").textContent ?? "", /partially completed/);

  fireEvent.click(screen.getByRole("button", { name: en["agent.detail.connections.retry"] }));
  await waitFor(() => assert.equal(del.mock.calls.length, 2));
  assert.deepEqual(del.mock.calls.map((call) => call[0]), [
    `/agents/${AGENT}/connections/github/connectors/ctr_mine`,
    `/agents/${AGENT}/connections/github/connectors/ctr_mine`,
  ]);
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-disconnect-partial") === null));
});
