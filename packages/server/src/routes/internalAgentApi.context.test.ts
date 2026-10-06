import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
// GET /internal/agent-api/context — identity bootstrap. A managed agent gets
// its identity and the CLI guide from the standing prompt its daemon builds;
// an external agent asks here. The prompt must be the daemon's self-hosted
// render (one shared builder), not a second copy of the text.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { buildRaftCliGuideMarkdown, type AgentApiAgentContextResponse } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { eq } from "drizzle-orm";
import { agents, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seed() {
  const suffix = randomUUID();
  const [owner] = await getDb().insert(users).values({
    email: `agent-context-${suffix}@slock.test`,
    name: `agent-context-${suffix}`,
    displayName: "Context Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Context Test Server", `agent-context-${suffix.slice(0, 8)}`, owner!.id);
  return { server };
}

async function getContext(baseUrl: string, apiKey: string) {
  return fetch(`${baseUrl}/internal/agent-api/context`, { headers: { Authorization: `Bearer ${apiKey}` } });
}

test("GET /context returns an external agent's identity, credential capabilities, and the daemon's self-hosted guide render", async ({ app }) => {
  const { server } = await seed();
  const agent = await createAgent(server.id, "ctx-external", {
    runtime: "external",
    model: "external",
    description: "Reviews pull requests",
  });
  await getDb().update(agents).set({ displayName: "Context External" }).where(eq(agents.id, agent.id));
  const minted = await mintAgentCredential({ agentId: agent.id, scopes: ["read", "send"], name: "ctx", createdByUserId: null });

  const res = await getContext(app.baseUrl, minted.apiKey);
  assert.equal(res.status, 200);
  const body = await res.json() as AgentApiAgentContextResponse;
  assert.deepEqual(body.agent, {
    id: agent.id,
    name: "ctx-external",
    displayName: "Context External",
    description: "Reviews pull requests",
    runtime: "external",
    external: true,
  });
  assert.deepEqual(body.server, { id: server.id, slug: server.slug, name: "Context Test Server" });
  assert.deepEqual([...body.credential.capabilities].sort(), ["read", "send"]);
  assert.equal(body.prompt?.audience, "self-hosted-runner");
  assert.equal(body.prompt?.text, buildRaftCliGuideMarkdown({
    handle: "ctx-external",
    displayName: "Context External",
    description: "Reviews pull requests",
    serverName: "Context Test Server",
  }));
  assert.match(body.prompt!.text, /You are "Context External" \(@ctx-external\), an external AI agent in the Raft server "Context Test Server"/);
  assert.match(body.prompt!.text, /Initial role: Reviews pull requests\./);
  assert.match(body.prompt!.text, /reminders_unsupported_for_external_agents/);
  assert.doesNotMatch(body.prompt!.text, /<your-handle>|<your-display-name>/);
});

test("GET /context returns no prompt for a managed agent: its prompt comes from its daemon", async ({ app }) => {
  const { server } = await seed();
  const agent = await createAgent(server.id, "ctx-managed", { runtime: "claude" });
  const minted = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: "ctx", createdByUserId: null });

  const res = await getContext(app.baseUrl, minted.apiKey);
  assert.equal(res.status, 200);
  const body = await res.json() as AgentApiAgentContextResponse;
  assert.equal(body.agent.external, false);
  assert.equal(body.agent.name, "ctx-managed");
  assert.equal(body.prompt, null);
});

test("GET /context is gated by the read capability", async ({ app }) => {
  const { server } = await seed();
  const agent = await createAgent(server.id, "ctx-noread", { runtime: "external", model: "external" });
  const minted = await mintAgentCredential({ agentId: agent.id, scopes: ["send"], name: "ctx", createdByUserId: null });

  const res = await getContext(app.baseUrl, minted.apiKey);
  assert.equal(res.status, 403);
  const body = await res.json() as { code?: string; requiredCapability?: string };
  assert.equal(body.code, "capability_not_authorized");
  assert.equal(body.requiredCapability, "read");
});
