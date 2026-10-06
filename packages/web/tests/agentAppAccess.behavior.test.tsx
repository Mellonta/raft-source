import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentAppEventSummary } from "@botiverse/raft-shared";
import api from "../src/api/client";
import AgentAppAccessTab from "../src/components/agent/AgentAppAccessTab";
import { TestIntlProvider } from "./helpers/intl";

const originalGet = api.get;
const originalPost = api.post;

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
});

function event(id: string, overrides: Partial<AgentAppEventSummary> = {}): AgentAppEventSummary {
  return {
    id,
    app: { clientId: "client-1", clientKey: "reminder-app", name: "Reminder App", logoUrl: null },
    kind: "notification",
    summary: `Reminder ${id}`,
    status: "delivered",
    externalEventId: null,
    createdAt: "2026-10-05T03:00:00.000Z",
    deliveredAt: "2026-10-05T03:00:01.000Z",
    expiresAt: "2026-10-12T03:00:00.000Z",
    payloadBytes: 20,
    ...overrides,
  };
}

function mockApi(posts: Array<{ url: string; body: unknown }>) {
  api.get = (async (url: string, config?: { params?: Record<string, string> }) => {
    if (url === "/integrations/agents/agent-1") {
      return {
        data: [
          { id: "req-1", type: "pending", clientId: "client-2", clientName: "Notes App", clientDescription: null, clientHomepageUrl: null, clientAgentManifestUrl: null, scopes: ["agent:event:write"], createdAt: "2026-10-05T02:00:00.000Z", grantSource: null },
          { id: "grant-1", type: "active", clientId: "client-1", clientName: "Reminder App", clientDescription: null, clientHomepageUrl: null, clientAgentManifestUrl: null, scopes: ["agent:notification:write"], createdAt: "2026-10-05T01:00:00.000Z", grantSource: "agent_login" },
        ],
      };
    }
    if (url === "/integrations/agents/agent-1/events") {
      if (config?.params?.before === "cursor-1") return { data: { events: [event("e3", { status: "expired" })], nextCursor: null } };
      return { data: { events: [event("e1"), event("e2", { status: "queued" })], nextCursor: "cursor-1" } };
    }
    if (url === "/integrations/agents/agent-1/events/e1") {
      return { data: { ...event("e1"), payload: { text: "<b>not markup</b>", channel: "general" } } };
    }
    if (url === "/integrations/agents/agent-1/grantable-apps") {
      return { data: { apps: [{ clientId: "client-3", clientKey: "vault", name: "Vault App", description: null, logoUrl: null, scopes: ["agent:event:write", "agent:notification:write"] }] } };
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    posts.push({ url, body });
    return { data: {} };
  }) as typeof api.post;
}

function renderTab(canManageAgentAccess: boolean) {
  render(
    <TestIntlProvider>
      <AgentAppAccessTab agentId="agent-1" canManageAgentAccess={canManageAgentAccess} />
    </TestIntlProvider>,
  );
}

test("apps tab shows how access was granted, pending requests, and paged app events with inert payloads", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  mockApi(posts);
  renderTab(true);

  await screen.findByText(/Granted when the agent signed in/);
  await screen.findByText("Reminder e1");
  assert.ok(screen.queryByText("Notes App") !== null);

  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  await waitFor(() => assert.deepEqual(posts[0], { url: "/integrations/requests/req-1/approve", body: { remember: true } }));

  // Payload is fetched on open and shown as JSON text, not rendered as markup.
  fireEvent.click(screen.getByText("Reminder e1"));
  const payload = await screen.findByText(/not markup/);
  assert.ok(payload.tagName === "PRE");
  assert.ok(document.querySelector("[data-testid='agent-app-events'] b") === null);

  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await screen.findByText("Reminder e3");
  assert.ok(screen.queryByRole("button", { name: "Load more" }) === null);
});

test("grant access picks an app and its scopes, and is hidden from people who can't manage access", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  mockApi(posts);
  renderTab(true);

  fireEvent.click(await screen.findByRole("button", { name: "Grant access" }));
  fireEvent.click(await screen.findByRole("button", { name: /Vault App/ }));
  // Untick one scope, then confirm.
  const form = within(screen.getByTestId("agent-grant-access-form"));
  fireEvent.click(form.getByText("agent:event:write"));
  const confirm = form.getByRole("button", { name: "Grant access" });
  fireEvent.click(confirm);
  await waitFor(() => assert.deepEqual(posts.at(-1), {
    url: "/integrations/agents/agent-1/grants",
    body: { clientId: "client-3", scopes: ["agent:notification:write"] },
  }));

  cleanup();
  mockApi([]);
  renderTab(false);
  await screen.findByText("Reminder e1");
  assert.ok(screen.queryByRole("button", { name: "Grant access" }) === null);
  assert.ok(screen.queryByRole("button", { name: "Revoke" }) === null);
  assert.ok(screen.queryByRole("button", { name: "Approve" }) === null);
});
