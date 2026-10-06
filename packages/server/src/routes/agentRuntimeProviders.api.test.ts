// Hosted runtime provider (raft-agent-provider.v1) end to end against a fake
// provider HTTP server: admin-only config with the token never returned, the
// create → provision worker flow (identical-body retry after a lost response,
// 5xx backoff, 4xx → failed + manual retry), PATCH on edit, delete revoking
// credentials before the provider DELETE, and cross-server isolation.
import { tokenForHuman, fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ANTIPROTON_HOSTED_RUNTIME_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/index";
import { agentCredentials, agentRuntimeProvisions, agents, featureFlagRules, integrationAuditEvents, serverMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { findAgentCredentialByApiKey } from "../services/agentCredentialService";
import { __setAgentRuntimeProviderTransportForTests, resolveProviderConfig } from "../services/agentRuntimeProviderService";
import { buildAgentConnectionLandingUrl } from "../services/agentConnectionService";
import {
  claimProvision,
  drainAgentRuntimeProvisions,
  PROVISION_RETRY_BASE_MS,
} from "../services/agentRuntimeProvisionService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

const PROVIDER_TOKEN = "pt-fake-provider-token-0123456789abcdef";
const RAFT_ORIGIN = "https://raft.example.test";

type Recorded = { method: string; path: string; headers: IncomingMessage["headers"]; body: string };
type Reply = { status: number; body?: unknown } | "lose-response";
type Handler = (request: Recorded) => Reply | Promise<Reply>;

async function startFakeProvider() {
  const requests: Recorded[] = [];
  const queue: Handler[] = [];
  let fallback: Handler = (request) => defaultReply(request);
  const lost = new Set<Recorded>();

  function defaultReply(request: Recorded): Reply {
    if (request.headers.authorization !== `Bearer ${PROVIDER_TOKEN}`) {
      return { status: 401, body: { error: { code: "unauthorized", message: "bad token" } } };
    }
    if (request.method === "POST" && request.path === "/provision/agents") {
      const body = JSON.parse(request.body) as { raftAgentId: string };
      return { status: 201, body: { providerAgentId: `raft_${body.raftAgentId}`, status: "active", push: { registered: true } } };
    }
    if (request.method === "GET") return { status: 404, body: { error: { code: "not_found", message: "no agent" } } };
    return { status: 200, body: {} };
  }

  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const recorded: Recorded = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      requests.push(recorded);
      const handler = queue.shift() ?? fallback;
      const reply = await handler(recorded);
      let answer = reply;
      if (answer === "lose-response") {
        // The provider did the work, but the answer never reaches Raft.
        lost.add(recorded);
        answer = defaultReply(recorded) as { status: number; body?: unknown };
      }
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(answer.body === undefined ? "" : JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Transport: real HTTP to the fake, but a "lost" answer surfaces as a timeout.
  const fetchThroughFake: typeof globalThis.fetch = async (input, init) => {
    const before = requests.length;
    const response = await globalThis.fetch(input, init);
    const text = await response.text();
    const recorded = requests[before];
    if (recorded && lost.has(recorded)) {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    }
    return new Response(text || null, { status: response.status, headers: response.headers });
  };
  // The fake stands in for the deployment's fixed antiproton base URL.
  __setAgentRuntimeProviderTransportForTests({ fetch: fetchThroughFake, baseUrl });
  return {
    baseUrl,
    requests,
    next(handler: Handler) { queue.push(handler); },
    setFallback(handler: Handler) { fallback = handler; },
    async close() {
      __setAgentRuntimeProviderTransportForTests(null);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function seedUser(email: string, name: string) {
  const [user] = await getDb().insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

const ENV_KEYS = ["SLOCK_PROVIDER_CREDENTIAL_KEY", "SERVER_URL", "DEPLOYMENT_ENV", "ANTIPROTON_PROVISIONING_TOKEN"] as const;

function withEnv<T>(run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.SERVER_URL = `${RAFT_ORIGIN}/`;
  delete process.env.DEPLOYMENT_ENV;
  delete process.env.ANTIPROTON_PROVISIONING_TOKEN;
  return run().finally(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });
}

/** Deployment-level provider config: the only setting is the token secret (the base URL is the fake's). */
function configureDeployment(_fake: { baseUrl: string }) {
  process.env.ANTIPROTON_PROVISIONING_TOKEN = PROVIDER_TOKEN;
}

/** Per-server gate: a `server` stage allow rule on the flag, as the Feature Flag Admin writes it. */
async function enableFlagFor(serverId: string) {
  await getDb().insert(featureFlagRules).values({
    id: randomUUID(),
    flagKey: ANTIPROTON_HOSTED_RUNTIME_FEATURE_FLAG_KEY,
    stage: "server",
    priority: -100,
    decision: "allow",
    values: [serverId],
  });
}

function api(baseUrl: string, token: string, serverId: string) {
  const headers = { Authorization: `Bearer ${token}`, "X-Server-Id": serverId, "Content-Type": "application/json" };
  return {
    get: (path: string) => fetch(`${baseUrl}/api${path}`, { headers }),
    send: (method: string, path: string, body?: unknown) =>
      fetch(`${baseUrl}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
  };
}

/** Advance the worker clock past any backoff. */
const later = (ms: number) => () => new Date(Date.now() + ms);

async function provisionRow(agentId: string) {
  const [row] = await getDb().select().from(agentRuntimeProvisions).where(eq(agentRuntimeProvisions.agentId, agentId));
  return row;
}

async function setupServer(baseUrl: string, slug: string) {
  const owner = await seedUser(`${slug}-owner@raft.test`, `${slug}-owner`);
  const member = await seedUser(`${slug}-member@raft.test`, `${slug}-member`);
  const server = await createServer(`Provider ${slug}`, slug, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  return {
    server,
    owner: api(baseUrl, await tokenForHuman(owner.email), server.id),
    member: api(baseUrl, await tokenForHuman(member.email), server.id),
  };
}

async function configure(fake: { baseUrl: string }, target: { server: { id: string } }) {
  configureDeployment(fake);
  await enableFlagFor(target.server.id);
}

async function createHosted(client: ReturnType<typeof api>, name: string, description = "Be helpful.") {
  const res = await client.send("POST", "/agents", { name, description, external: true, provider: "antiproton" });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return JSON.parse(text) as { id: string; hostedRuntime?: { state: string } };
}

test("availability needs both the deployment env config and the server flag; the probe exposes nothing else", async ({ app }) => {
  await withEnv(async () => {
    const fake = await startFakeProvider();
    try {
      const a = await setupServer(app.baseUrl, "provider-gate-a");
      const b = await setupServer(app.baseUrl, "provider-gate-b");
      const probe = async (client: ReturnType<typeof api>) => {
        const res = await client.get("/agent-runtime-providers/antiproton");
        const text = await res.text();
        assert.equal(res.status, 200, text);
        assert.ok(!text.includes(PROVIDER_TOKEN) && !text.includes(fake.baseUrl), "the probe exposes no configuration");
        return JSON.parse(text) as { kind: string; available: boolean };
      };
      const createCode = async (client: ReturnType<typeof api>, name: string) => {
        const res = await client.send("POST", "/agents", { name, external: true, provider: "antiproton" });
        return { status: res.status, code: (await res.json() as { code?: string }).code };
      };

      assert.equal((await a.member.get("/agent-runtime-providers/antiproton")).status, 403);
      assert.equal((await a.owner.get("/agent-runtime-providers/nope")).status, 404);
      for (const method of ["PUT", "DELETE"]) {
        assert.equal((await a.owner.send(method, "/agent-runtime-providers/antiproton", { baseUrl: fake.baseUrl, token: PROVIDER_TOKEN })).status, 404, `${method} config route is gone`);
      }

      // Flag off (default) and no env: unavailable, create refused by the flag.
      assert.deepEqual(await probe(a.owner), { kind: "antiproton", available: false });
      assert.deepEqual(await createCode(a.owner, "gate-off"), { status: 403, code: "agent_runtime_provider_disabled" });

      // Env configured, flag still off: unavailable.
      configureDeployment(fake);
      assert.equal((await probe(a.owner)).available, false);
      assert.deepEqual(await createCode(a.owner, "gate-flag-off"), { status: 403, code: "agent_runtime_provider_disabled" });

      // Flag on for A only, env unset: unavailable with a clear configuration error.
      await enableFlagFor(a.server.id);
      delete process.env.ANTIPROTON_PROVISIONING_TOKEN;
      assert.equal((await probe(a.owner)).available, false);
      assert.deepEqual(await createCode(a.owner, "gate-no-token"), { status: 409, code: "agent_runtime_provider_not_configured" });

      // Both: available for A, still not for B (cross-server isolation).
      configureDeployment(fake);
      assert.equal((await probe(a.owner)).available, true);
      assert.equal((await probe(b.owner)).available, false);
      assert.deepEqual(await createCode(b.owner, "gate-b"), { status: 403, code: "agent_runtime_provider_disabled" });
      const created = await createHosted(a.owner, "gate-on");
      assert.equal(created.hostedRuntime?.state, "provisioning");
      assert.equal(fake.requests.length, 0, "availability never calls the provider");

      const managed = await a.owner.send("POST", "/agents", { name: "managed-hosted", provider: "antiproton" });
      assert.equal(managed.status, 400, "provider is only for external agents");
    } finally {
      await fake.close();
    }
  });
});

test("turning the flag off rejects the hosted-runtime routes but existing rows keep syncing", async ({ app }) => {
  await withEnv(async () => {
    const fake = await startFakeProvider();
    try {
      const a = await setupServer(app.baseUrl, "provider-flag-off");
      await configure(fake, a);
      const created = await createHosted(a.owner, "flag-off-agent");
      await getDb().delete(featureFlagRules).where(eq(featureFlagRules.flagKey, ANTIPROTON_HOSTED_RUNTIME_FEATURE_FLAG_KEY));
      for (const [method, path] of [
        ["GET", `/agents/${created.id}/hosted-runtime`],
        ["POST", `/agents/${created.id}/hosted-runtime/retry`],
        ["GET", `/agents/${created.id}/hosted-runtime/usage`],
        ["GET", `/agents/${created.id}/workspace-files`],
        ["GET", `/agents/${created.id}/workspace-files/read?path=state%2Fa.md`],
      ] as const) {
        const res = await a.owner.send(method, path);
        assert.equal(res.status, 403, `${method} ${path}`);
        assert.equal((await res.json() as { code: string }).code, "agent_runtime_provider_disabled");
      }
      await drainAgentRuntimeProvisions();
      assert.equal((await provisionRow(created.id)).state, "active", "already-created agents are still provisioned");
      assert.equal((await a.owner.send("DELETE", `/agents/${created.id}`)).status, 200);
      await drainAgentRuntimeProvisions();
      assert.equal((await provisionRow(created.id)).state, "deleted", "and still deleted on the provider");
    } finally {
      await fake.close();
    }
  });
});

test("create provisions with an identical-body retry after a lost answer, and the raw key never leaves the row", async ({ app }) => {
  await withEnv(async () => {
    const fake = await startFakeProvider();
    try {
      const a = await setupServer(app.baseUrl, "provider-create");
      await configure(fake, a);
      const created = await createHosted(a.owner, "hosted-agent", "You review pull requests.");
      assert.equal(created.hostedRuntime?.state, "provisioning");

      const pending = await provisionRow(created.id);
      assert.ok(pending.encryptedCredential && !pending.encryptedCredential.startsWith("sk_agent_"));
      assert.ok(pending.credentialId);

      fake.next(() => "lose-response");
      const first = await drainAgentRuntimeProvisions();
      assert.equal(first.retried, 1);
      const afterLoss = await provisionRow(created.id);
      assert.equal(afterLoss.state, "provisioning");
      assert.equal(afterLoss.lastErrorCode, "provider_timeout");
      assert.ok(afterLoss.nextAttemptAt.getTime() > Date.now(), "backoff before the retry");

      // Not due yet: nothing is sent.
      const posts = () => fake.requests.filter((r) => r.method === "POST");
      assert.equal((await drainAgentRuntimeProvisions()).claimed, 0);
      assert.equal(posts().length, 1);

      await drainAgentRuntimeProvisions({ now: later(PROVISION_RETRY_BASE_MS + 1_000) });
      assert.equal(posts().length, 2);
      assert.equal(posts()[0].body, posts()[1].body, "the retried POST is byte-identical");
      for (const post of posts()) {
        assert.equal(post.headers["idempotency-key"], created.id);
        assert.equal(post.headers.authorization, `Bearer ${PROVIDER_TOKEN}`);
      }
      const sent = JSON.parse(posts()[0].body) as Record<string, string>;
      assert.deepEqual(Object.keys(sent).sort(), ["credential", "instructions", "name", "raftAgentId", "raftOrigin", "raftServerId"]);
      assert.equal(sent.raftAgentId, created.id);
      assert.equal(sent.raftServerId, a.server.id);
      assert.equal(sent.raftOrigin, RAFT_ORIGIN);
      assert.equal(sent.name, "hosted-agent");
      assert.equal(sent.instructions, "You review pull requests.");
      const verified = await findAgentCredentialByApiKey(sent.credential);
      assert.equal(verified?.agentId, created.id, "the provider received a working sk_agent credential for this agent");

      const active = await provisionRow(created.id);
      assert.equal(active.state, "active");
      assert.equal(active.providerAgentId, `raft_${created.id}`);
      assert.equal(active.encryptedCredential, null, "raw key deleted once provisioning succeeded");
      assert.equal(active.lastErrorCode, null);

      for (const path of [`/agents/${created.id}`, "/agents", `/agents/${created.id}/external-status`, `/agents/${created.id}/hosted-runtime`, `/agents/${created.id}/credentials`]) {
        const res = await a.owner.get(path);
        const text = await res.text();
        assert.equal(res.status, 200, `${path}: ${text}`);
        assert.ok(!text.includes(sent.credential), `${path} never returns the raw key`);
        assert.ok(!text.includes(PROVIDER_TOKEN), `${path} never returns the provider token`);
      }
      const detail = await (await a.owner.get(`/agents/${created.id}`)).json() as { hostedRuntime: { state: string; providerAgentId: string; push: unknown } };
      assert.equal(detail.hostedRuntime.state, "active");
      assert.equal(detail.hostedRuntime.providerAgentId, `raft_${created.id}`);
      assert.deepEqual(detail.hostedRuntime.push, { registered: true, error: null });
      const memberView = await (await a.member.get(`/agents/${created.id}`)).json() as Record<string, unknown>;
      assert.equal(memberView.hostedRuntime, undefined, "only managers see provisioning details");
    } finally {
      await fake.close();
    }
  });
});

test("5xx backs off then succeeds; 4xx fails visibly without retrying until a manual retry", async ({ app }) => {
  await withEnv(async () => {
    const fake = await startFakeProvider();
    try {
      const a = await setupServer(app.baseUrl, "provider-errors");
      await configure(fake, a);

      const flaky = await createHosted(a.owner, "flaky-agent");
      fake.next(() => ({ status: 503, body: { error: { code: "internal", message: "busy" } } }));
      await drainAgentRuntimeProvisions();
      let row = await provisionRow(flaky.id);
      assert.equal(row.state, "provisioning");
      assert.equal(row.lastErrorHttpStatus, 503);
      const firstBackoff = row.nextAttemptAt.getTime() - Date.now();
      fake.next(() => ({ status: 502, body: { error: { code: "internal", message: "busy" } } }));
      await drainAgentRuntimeProvisions({ now: later(PROVISION_RETRY_BASE_MS + 1_000) });
      row = await provisionRow(flaky.id);
      assert.equal(row.attemptCount, 2);
      assert.ok(row.nextAttemptAt.getTime() - Date.now() > firstBackoff + PROVISION_RETRY_BASE_MS / 2, "exponential backoff grows");
      await drainAgentRuntimeProvisions({ now: later(10 * PROVISION_RETRY_BASE_MS) });
      row = await provisionRow(flaky.id);
      assert.equal(row.state, "active");
      assert.equal(row.attemptCount, 0);

      const refused = await createHosted(a.owner, "refused-agent");
      fake.next(() => ({ status: 409, body: { error: { code: "idempotency_conflict", message: "a different request was already made under this key" } } }));
      await drainAgentRuntimeProvisions();
      row = await provisionRow(refused.id);
      assert.equal(row.state, "failed");
      assert.ok(row.encryptedCredential, "kept for a manual retry");
      const postsBefore = fake.requests.length;
      await drainAgentRuntimeProvisions({ now: later(60 * 60_000) });
      assert.equal(fake.requests.length, postsBefore, "no automatic retry after a 4xx");
      const status = await (await a.owner.get(`/agents/${refused.id}/hosted-runtime`)).json() as {
        hostedRuntime: { state: string; lastError: { code: string; httpStatus: number; message: string } };
      };
      assert.equal(status.hostedRuntime.state, "failed");
      assert.equal(status.hostedRuntime.lastError.code, "idempotency_conflict");
      assert.equal(status.hostedRuntime.lastError.httpStatus, 409);

      assert.equal((await a.member.send("POST", `/agents/${refused.id}/hosted-runtime/retry`)).status, 403);
      const retry = await a.owner.send("POST", `/agents/${refused.id}/hosted-runtime/retry`);
      assert.equal(retry.status, 200);
      await drainAgentRuntimeProvisions();
      assert.equal((await provisionRow(refused.id)).state, "active");
    } finally {
      await fake.close();
    }
  });
});

test("edits PATCH the provider in order; an edit during provisioning keeps the POST body frozen", async ({ app }) => {
  await withEnv(async () => {
    const fake = await startFakeProvider();
    try {
      const a = await setupServer(app.baseUrl, "provider-edit");
      await configure(fake, a);
      const created = await createHosted(a.owner, "edit-agent", "v1");

      const edit = await a.owner.send("PATCH", `/agents/${created.id}`, { displayName: "Edit Agent", description: "v2" });
      assert.equal(edit.status, 200, await edit.clone().text());
      await drainAgentRuntimeProvisions();
      const post = fake.requests.find((r) => r.method === "POST")!;
      assert.equal(JSON.parse(post.body).instructions, "v1", "POST replays the frozen body, never the edit");
      await drainAgentRuntimeProvisions();
      const patch = fake.requests.find((r) => r.method === "PATCH")!;
      assert.equal(patch.path, `/provision/agents/raft_${created.id}?raftServerId=${a.server.id}`, "PATCH carries the Raft server");
      assert.deepEqual(JSON.parse(patch.body), { name: "Edit Agent", instructions: "v2" });

      await a.owner.send("PATCH", `/agents/${created.id}`, { description: "v3" });
      await a.owner.send("PATCH", `/agents/${created.id}`, { description: "v4" });
      await drainAgentRuntimeProvisions();
      const patches = fake.requests.filter((r) => r.method === "PATCH");
      assert.deepEqual(JSON.parse(patches.at(-1)!.body), { name: "Edit Agent", instructions: "v4" }, "last write wins");
      const row = await provisionRow(created.id);
      assert.equal(row.syncedRevision, row.desiredRevision);
      assert.equal((await drainAgentRuntimeProvisions()).claimed, 0);
    } finally {
      await fake.close();
    }
  });
});

test("delete revokes the credential before the provider DELETE and retries until 2xx/404", async ({ app }) => {
  await withEnv(async () => {
    const fake = await startFakeProvider();
    try {
      const a = await setupServer(app.baseUrl, "provider-delete");
      await configure(fake, a);
      const created = await createHosted(a.owner, "doomed-agent");
      await drainAgentRuntimeProvisions();
      const credential = JSON.parse(fake.requests.find((r) => r.method === "POST")!.body).credential as string;
      assert.ok(await findAgentCredentialByApiKey(credential));

      const activeCredentialsAtDelete: number[] = [];
      const recordAndReply = (reply: Reply): Handler => async () => {
        const active = await getDb().select({ id: agentCredentials.id }).from(agentCredentials)
          .where(and(eq(agentCredentials.agentId, created.id), isNull(agentCredentials.revokedAt)));
        activeCredentialsAtDelete.push(active.length);
        return reply;
      };
      fake.next(recordAndReply({ status: 500, body: { error: { code: "internal", message: "down" } } }));
      fake.next(recordAndReply({ status: 401, body: { error: { code: "unauthorized", message: "token revoked" } } }));
      fake.next(recordAndReply({ status: 404, body: { error: { code: "not_found", message: "gone" } } }));

      const del = await a.owner.send("DELETE", `/agents/${created.id}`);
      assert.equal(del.status, 200);
      assert.equal(await findAgentCredentialByApiKey(credential), null, "credential unusable right after delete");
      assert.equal((await provisionRow(created.id)).state, "deleting");

      await drainAgentRuntimeProvisions();
      assert.equal((await provisionRow(created.id)).state, "deleting", "5xx keeps the tombstone");
      await drainAgentRuntimeProvisions({ now: later(PROVISION_RETRY_BASE_MS + 1_000) });
      assert.equal((await provisionRow(created.id)).state, "deleting", "4xx other than 404 keeps the tombstone");
      await drainAgentRuntimeProvisions({ now: later(60 * 60_000) });
      const row = await provisionRow(created.id);
      assert.equal(row.state, "deleted");
      assert.ok(row.deletedAt);
      const deletes = fake.requests.filter((r) => r.method === "DELETE");
      assert.equal(deletes.length, 3);
      assert.ok(deletes.every((r) => r.path === `/provision/agents/by-raft-agent/${created.id}?raftServerId=${a.server.id}`), "delete addresses the provider by Raft agent id");
      assert.deepEqual(activeCredentialsAtDelete, [0, 0, 0], "no active credential when the provider DELETE is sent");

    } finally {
      await fake.close();
    }
  });
});

test("deleting an agent whose POST is in flight still reaches the provider DELETE", async ({ app }) => {
  await withEnv(async () => {
    const fake = await startFakeProvider();
    try {
      const a = await setupServer(app.baseUrl, "provider-race");
      await configure(fake, a);
      const created = await createHosted(a.owner, "racing-agent");
      fake.next(async (request) => {
        // The Raft agent is deleted while the provider is still answering the POST.
        const del = await a.owner.send("DELETE", `/agents/${created.id}`);
        assert.equal(del.status, 200);
        const body = JSON.parse(request.body) as { raftAgentId: string };
        return { status: 201, body: { providerAgentId: `raft_${body.raftAgentId}`, push: { registered: true } } };
      });
      await drainAgentRuntimeProvisions();
      let row = await provisionRow(created.id);
      assert.equal(row.state, "deleting", "a late POST success does not resurrect the agent");
      assert.equal(row.providerAgentId, `raft_${created.id}`);
      fake.next(() => ({ status: 200, body: { status: "deleted" } }));
      await drainAgentRuntimeProvisions();
      row = await provisionRow(created.id);
      assert.equal(row.state, "deleted");
      assert.deepEqual(fake.requests.filter((r) => r.method === "DELETE").map((r) => r.path), [`/provision/agents/by-raft-agent/${created.id}?raftServerId=${a.server.id}`]);
    } finally {
      await fake.close();
    }
  });
});

test("POST succeeded but its answer was lost, then the agent is deleted: the provider DELETE is still sent by Raft agent id", async ({ app }) => {
  await withEnv(async () => {
    const fake = await startFakeProvider();
    try {
      const a = await setupServer(app.baseUrl, "provider-orphan");
      await configure(fake, a);
      const created = await createHosted(a.owner, "orphan-agent");
      fake.next(() => "lose-response");
      await drainAgentRuntimeProvisions();
      let row = await provisionRow(created.id);
      assert.equal(row.state, "provisioning");
      assert.equal(row.providerAgentId, null, "Raft never learned the provider id");

      assert.equal((await a.owner.send("DELETE", `/agents/${created.id}`)).status, 200);
      fake.next(() => ({ status: 200, body: { status: "deleted" } }));
      await drainAgentRuntimeProvisions();
      row = await provisionRow(created.id);
      assert.equal(row.state, "deleted");
      assert.deepEqual(
        fake.requests.filter((r) => r.method === "DELETE").map((r) => r.path),
        [`/provision/agents/by-raft-agent/${created.id}?raftServerId=${a.server.id}`],
      );

      // A provider that never created the agent answers 404: also done.
      const never = await createHosted(a.owner, "never-created-agent");
      fake.next(() => ({ status: 422, body: { error: { code: "credential_refused", message: "no" } } }));
      await drainAgentRuntimeProvisions();
      assert.equal((await provisionRow(never.id)).state, "failed");
      await a.owner.send("DELETE", `/agents/${never.id}`);
      fake.next(() => ({ status: 404, body: { error: { code: "not_found", message: "never created" } } }));
      await drainAgentRuntimeProvisions();
      assert.equal((await provisionRow(never.id)).state, "deleted");
    } finally {
      await fake.close();
    }
  });
});

test("live status passthrough GETs the provider by Raft agent id", async ({ app }) => {
  await withEnv(async () => {
    const fake = await startFakeProvider();
    try {
      const a = await setupServer(app.baseUrl, "provider-live");
      await configure(fake, a);
      const created = await createHosted(a.owner, "live-agent");
      await drainAgentRuntimeProvisions();
      fake.next(() => ({ status: 200, body: { providerAgentId: `raft_${created.id}`, status: "active", push: { registered: true, live: { ok: true } } } }));
      const res = await a.owner.get(`/agents/${created.id}/hosted-runtime?live=1`);
      assert.equal(res.status, 200);
      const body = await res.json() as { provider: { status: { status: string } } };
      assert.equal(body.provider.status.status, "active");
      const get = fake.requests.at(-1)!;
      assert.equal(get.method, "GET");
      assert.equal(get.path, `/provision/agents/by-raft-agent/${created.id}?raftServerId=${a.server.id}`);
    } finally {
      await fake.close();
    }
  });
});

test("hosted workspace files and usage are proxied to the provider by its agent id", async ({ app }) => {
  await withEnv(async () => {
    const fake = await startFakeProvider();
    try {
      const a = await setupServer(app.baseUrl, "provider-surface");
      await configure(fake, a);
      const created = await createHosted(a.owner, "surface-agent");
      const providerBase = `/provision/agents/raft_${created.id}`;
      const workspace = `/agents/${created.id}/workspace-files`;
      const errorOf = async (res: Response) => ({ status: res.status, code: (await res.json() as { code?: string }).code });

      // Still provisioning: the provider agent id is not known yet, nothing is called.
      const before = fake.requests.length;
      assert.deepEqual(await errorOf(await a.owner.get(workspace)), { status: 409, code: "hosted_runtime_workspace_not_ready" });
      assert.equal(fake.requests.length, before);
      await drainAgentRuntimeProvisions();

      assert.equal((await a.member.get(workspace)).status, 403, "private surface: editAgents or creator only");

      fake.next(() => ({
        status: 200,
        body: {
          files: [{ name: "notes", path: "state/notes", isDirectory: true, size: 0, modifiedAt: "2026-10-01T00:00:00.000Z", providerOnly: 1 }],
          truncated: true,
          omitted: 3,
        },
      }));
      const list = await a.owner.get(`${workspace}?dirPath=${encodeURIComponent("state/notes")}&includeHidden=true`);
      assert.equal(list.status, 200);
      assert.deepEqual(await list.json(), {
        files: [{ name: "notes", path: "state/notes", isDirectory: true, size: 0, modifiedAt: "2026-10-01T00:00:00.000Z" }],
        truncated: true,
        omitted: 3,
      });
      const listCall = fake.requests.at(-1)!;
      assert.equal(listCall.method, "GET");
      assert.equal(listCall.headers.authorization, `Bearer ${PROVIDER_TOKEN}`);
      assert.equal(listCall.path, `${providerBase}/workspace-files?raftServerId=${a.server.id}&dirPath=state%2Fnotes&includeHidden=true`);

      fake.next(() => ({ status: 200, body: { content: "hello", binary: false, size: 5, mimeType: "text/plain", encoding: "utf-8" } }));
      const read = await a.owner.get(`${workspace}/read?path=${encodeURIComponent("artifacts/a b.txt")}`);
      assert.equal(read.status, 200);
      const file = await read.json() as Record<string, unknown>;
      assert.equal(file.path, "artifacts/a b.txt");
      assert.equal(file.content, "hello");
      assert.equal(file.binary, false);
      assert.equal(file.size, 5);
      assert.equal(file.mimeType, "text/plain");
      assert.equal(file.encoding, "utf-8");
      assert.equal(typeof file.modifiedAt, "string");
      assert.equal(fake.requests.at(-1)!.path, `${providerBase}/workspace-files/read?raftServerId=${a.server.id}&path=artifacts%2Fa%20b.txt`);

      fake.next(() => ({ status: 404, body: { error: { code: "not_found", message: "no such file" } } }));
      assert.deepEqual(await errorOf(await a.owner.get(`${workspace}/read?path=missing.txt`)), { status: 404, code: "hosted_runtime_workspace_not_found" });
      fake.next(() => ({ status: 400, body: { error: { code: "not_a_directory", message: "is a file" } } }));
      assert.deepEqual(await errorOf(await a.owner.get(`${workspace}?dirPath=state%2Fa.md`)), { status: 400, code: "hosted_runtime_workspace_bad_request" });
      fake.next(() => ({ status: 502, body: { error: { code: "sandbox_unavailable", message: "backend down" } } }));
      assert.deepEqual(await errorOf(await a.owner.get(workspace)), { status: 502, code: "hosted_runtime_workspace_unavailable" });
      fake.next(() => "lose-response");
      assert.deepEqual(await errorOf(await a.owner.get(workspace)), { status: 502, code: "hosted_runtime_workspace_unavailable" });
      fake.next(() => ({ status: 200, body: { files: "not-a-list" } }));
      assert.deepEqual(await errorOf(await a.owner.get(workspace)), { status: 502, code: "hosted_runtime_workspace_unavailable" });

      // Usage: invalid windows are refused before any provider call.
      const usage = `/agents/${created.id}/hosted-runtime/usage`;
      const beforeInvalid = fake.requests.length;
      for (const query of [
        "from=2026-01-01T00:00:00.000Z&to=2026-03-01T00:00:00.000Z",
        "from=2026-02-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z",
        "from=yesterday",
        "bucket=5m",
      ]) {
        assert.deepEqual(await errorOf(await a.owner.get(`${usage}?${query}`)), { status: 400, code: "hosted_runtime_usage_invalid_query" }, query);
      }
      assert.equal(fake.requests.length, beforeInvalid);

      const usageBody = {
        raftAgentId: created.id,
        bucket: "1d",
        from: "2026-09-25T00:00:00.000Z",
        to: "2026-10-02T00:00:00.000Z",
        asOf: "2026-10-02T00:00:00.000Z",
        partial: false,
        rows: [{ at: "2026-10-01T00:00:00.000Z", resource: "model.tokens", dimensions: { model: "m1", kind: "input" }, unit: "tokens", quantity: 10 }],
      };
      fake.next(() => ({ status: 200, body: usageBody }));
      const usageRes = await a.owner.get(usage);
      assert.equal(usageRes.status, 200);
      assert.equal(usageRes.headers.get("cache-control"), "no-store");
      assert.deepEqual(await usageRes.json(), usageBody);
      const usageCall = new URL(fake.requests.at(-1)!.path, "http://provider.test");
      assert.equal(usageCall.pathname, `${providerBase}/usage`);
      assert.ok(usageCall.search.startsWith(`?raftServerId=${a.server.id}&`));
      assert.equal(usageCall.searchParams.get("bucket"), "1d");
      const window = Date.parse(usageCall.searchParams.get("to")!) - Date.parse(usageCall.searchParams.get("from")!);
      assert.equal(window, 7 * 24 * 60 * 60 * 1000, "defaults to the last 7 days");

      fake.next(() => ({ status: 200, body: usageBody }));
      const explicit = await a.owner.get(`${usage}?from=2026-09-01T00:00:00Z&to=2026-09-02T00:00:00Z&bucket=1h`);
      assert.equal(explicit.status, 200);
      assert.equal(
        fake.requests.at(-1)!.path,
        `${providerBase}/usage?raftServerId=${a.server.id}&from=2026-09-01T00%3A00%3A00.000Z&to=2026-09-02T00%3A00%3A00.000Z&bucket=1h`,
      );
    } finally {
      await fake.close();
    }
  });
});

test("an external agent without a hosted runtime keeps the machine workspace path and has no usage", async ({ app }) => {
  await withEnv(async () => {
    const fake = await startFakeProvider();
    try {
      const a = await setupServer(app.baseUrl, "provider-surface-plain");
      await configure(fake, a);
      const plainRes = await a.owner.send("POST", "/agents", { name: "plain-surface", external: true });
      const plain = await plainRes.json() as { id: string };
      assert.equal(plainRes.status, 200, JSON.stringify(plain));
      const before = fake.requests.length;
      for (const path of [`/agents/${plain.id}/workspace-files`, `/agents/${plain.id}/workspace-files/read?path=a.md`]) {
        const res = await a.owner.get(path);
        assert.equal(res.status, 409, path);
        assert.equal((await res.json() as { code: string }).code, "machine_unassigned");
      }
      const usage = await a.owner.get(`/agents/${plain.id}/hosted-runtime/usage`);
      assert.equal(usage.status, 404);
      assert.equal((await usage.json() as { code: string }).code, "hosted_runtime_missing");
      assert.equal(fake.requests.length, before, "no provider call for a non-hosted agent");
    } finally {
      await fake.close();
    }
  });
});

test("a claimed row has exactly one executor until its lease expires", async ({ app }) => {
  await withEnv(async () => {
    const fake = await startFakeProvider();
    try {
      const a = await setupServer(app.baseUrl, "provider-lease");
      await configure(fake, a);
      const created = await createHosted(a.owner, "leased-agent");
      const now = new Date(Date.now() + 1_000);
      const winners = (await Promise.all([
        claimProvision(created.id, "replica-a", now),
        claimProvision(created.id, "replica-b", now),
      ])).filter(Boolean);
      assert.equal(winners.length, 1);
      assert.equal((await drainAgentRuntimeProvisions({ leaseOwner: "replica-c" })).claimed, 0, "leased rows are skipped");
      // After the lease expires another replica may take over (the POST is idempotent).
      const takeover = await claimProvision(created.id, "replica-c", new Date(Date.now() + 5 * 60_000));
      assert.ok(takeover);
      assert.equal(takeover.leaseGeneration, winners[0]!.leaseGeneration + 1);
    } finally {
      await fake.close();
    }
  });
});

test("the antiproton base URL is fixed by DEPLOYMENT_ENV; only the token is configurable", () => {
  __setAgentRuntimeProviderTransportForTests(null);
  const token = { ANTIPROTON_PROVISIONING_TOKEN: PROVIDER_TOKEN };
  assert.equal(resolveProviderConfig("antiproton", { ...token, DEPLOYMENT_ENV: "staging" })?.baseUrl, "https://preview.antiproton.ai");
  assert.equal(resolveProviderConfig("antiproton", { ...token, DEPLOYMENT_ENV: "production" })?.baseUrl, "https://antiproton.ai");
  for (const deploymentEnv of [undefined, "dev", "test", "release-qa", "slockdev", "constructor"]) {
    assert.equal(resolveProviderConfig("antiproton", { ...token, DEPLOYMENT_ENV: deploymentEnv }), null, `${deploymentEnv}: no default provider`);
  }
  assert.equal(resolveProviderConfig("antiproton", { DEPLOYMENT_ENV: "production" }), null, "no token → unavailable");
  assert.equal(resolveProviderConfig("antiproton", { DEPLOYMENT_ENV: "production", ANTIPROTON_PROVISIONING_TOKEN: "  " }), null);
});

// ---------------------------------------------------------------------------
// Account connections (raft-agent-provider.v1 connections extension)
// ---------------------------------------------------------------------------

async function setupConnectionServer(baseUrl: string, slug: string) {
  const base = await setupServer(baseUrl, slug);
  const admin = await seedUser(`${slug}-admin@raft.test`, `${slug}-admin`);
  const creator = await seedUser(`${slug}-creator@raft.test`, `${slug}-creator`);
  const guest = await seedUser(`${slug}-guest@raft.test`, `${slug}-guest`);
  await getDb().insert(serverMembers).values([
    { serverId: base.server.id, userId: admin.id, role: "admin" },
    { serverId: base.server.id, userId: creator.id, role: "member" },
    { serverId: base.server.id, userId: guest.id, role: "guest" },
  ]);
  return {
    ...base,
    creatorUser: creator,
    guestUser: guest,
    admin: api(baseUrl, await tokenForHuman(admin.email), base.server.id),
    creator: api(baseUrl, await tokenForHuman(creator.email), base.server.id),
    guest: api(baseUrl, await tokenForHuman(guest.email), base.server.id),
  };
}

function connectionRequests(fake: { requests: Recorded[] }) {
  return fake.requests.filter((r) => r.path.includes("/connections/"));
}

test("connect GitHub: owner/admin/creator only, returnUrl from the Raft origin, initiatedBy bound to the caller", async ({ app }) => {
  await withEnv(async () => {
    const fake = await startFakeProvider();
    try {
      const a = await setupConnectionServer(app.baseUrl, "conn-perm");
      await configure(fake, a);
      const created = await createHosted(a.owner, "conn-agent");
      await drainAgentRuntimeProvisions();
      // The member "creator" owns the agent (a member cannot create agents itself).
      await getDb().update(agents).set({ creatorType: "user", creatorId: a.creatorUser.id }).where(eq(agents.id, created.id));
      const path = `/agents/${created.id}/connections/github`;
      const expectedPath = `/provision/agents/by-raft-agent/${created.id}/connections/github?raftServerId=${a.server.id}`;
      fake.setFallback((request) => {
        if (request.method === "POST" && request.path === expectedPath) {
          return { status: 200, body: { url: "https://github.com/login/oauth/authorize?state=abc", expiresAt: "2026-09-29T00:10:00.000Z", scopes: ["public_repo"] } };
        }
        return { status: 500, body: { error: { code: "unexpected", message: request.path } } };
      });

      // Forbidden callers never reach the provider.
      for (const [who, client] of [["member", a.member], ["guest", a.guest]] as const) {
        for (const method of ["GET", "POST", "DELETE"]) {
          const res = method === "GET" ? await client.get(path) : await client.send(method, path, method === "POST" ? {} : undefined);
          assert.equal(res.status, 403, `${who} ${method}`);
        }
      }
      // A guest who is the agent's creator is still refused.
      await getDb().update(agents).set({ creatorId: a.guestUser.id }).where(eq(agents.id, created.id));
      assert.equal((await a.guest.send("POST", path, {})).status, 403, "guest creator");
      await getDb().update(agents).set({ creatorId: a.creatorUser.id }).where(eq(agents.id, created.id));
      assert.equal(connectionRequests(fake).length, 0, "forbidden callers never reach the provider");

      for (const [who, client] of [["owner", a.owner], ["admin", a.admin], ["creator", a.creator]] as const) {
        const res = await client.send("POST", path, who === "admin" ? { access: "private" } : {});
        const text = await res.text();
        assert.equal(res.status, 200, `${who}: ${text}`);
        assert.deepEqual(JSON.parse(text), { url: "https://github.com/login/oauth/authorize?state=abc", expiresAt: "2026-09-29T00:10:00.000Z", scopes: ["public_repo"] });
      }
      const posts = connectionRequests(fake);
      assert.equal(posts.length, 3);
      const bodies = posts.map((r) => JSON.parse(r.body) as { returnUrl: string; initiatedBy: { raftUserId: string }; access?: string });
      for (const body of bodies) {
        assert.equal(body.returnUrl, `${RAFT_ORIGIN}/api/connections/callback/${a.server.id}/${created.id}`);
      }
      const idOf = async (email: string) => (await getDb().select({ id: users.id }).from(users).where(eq(users.email, email)))[0]!.id;
      assert.deepEqual(bodies.map((b) => b.initiatedBy.raftUserId), [
        await idOf("conn-perm-owner@raft.test"),
        await idOf("conn-perm-admin@raft.test"),
        a.creatorUser.id,
      ]);
      assert.deepEqual(bodies.map((b) => b.access), [undefined, "private", undefined]);
      assert.ok(posts.every((r) => r.headers.authorization === `Bearer ${PROVIDER_TOKEN}`));

      assert.equal((await a.owner.send("POST", path, { access: "admin" })).status, 400, "unknown access");
      assert.equal((await a.owner.send("POST", `/agents/${created.id}/connections/gitlab`, {})).status, 404, "provider allowlist");

      const audits = await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "agent_connection.connect_initiated"));
      assert.equal(audits.filter((row) => row.targetId === created.id && row.outcome === "success").length, 3);
      assert.ok(audits.every((row) => !JSON.stringify(row).includes("state=abc")), "the one-time URL is not audited");
    } finally {
      await fake.close();
    }
  });
});

test("connection status resolves connectedBy, disconnect deletes, provider 404 means not supported or agent missing, non-provider agents are refused", async ({ app }) => {
  await withEnv(async () => {
    const fake = await startFakeProvider();
    try {
      const a = await setupConnectionServer(app.baseUrl, "conn-status");
      await configure(fake, a);
      const created = await createHosted(a.owner, "conn-status-agent");
      const path = `/agents/${created.id}/connections/github`;

      // Still provisioning: the provider does not know the agent yet.
      assert.equal((await a.owner.get(path)).status, 409);
      await drainAgentRuntimeProvisions();

      fake.next(() => ({ status: 200, body: { connected: true, account: "octocat", connectedAt: "2026-09-29T00:00:00.000Z", connectedBy: a.creatorUser.id, scopes: ["public_repo"] } }));
      const statusRes = await a.admin.get(path);
      const status = await statusRes.json();
      assert.equal(statusRes.status, 200, JSON.stringify(status));
      assert.deepEqual(status, {
        provider: "github",
        supported: true,
        connected: true,
        account: "octocat",
        connectedAt: "2026-09-29T00:00:00.000Z",
        connectedBy: { id: a.creatorUser.id, name: a.creatorUser.displayName },
        scopes: ["public_repo"],
        connectorId: null,
        connectors: [],
      });
      assert.equal(fake.requests.at(-1)!.path, `/provision/agents/by-raft-agent/${created.id}/connections/github?raftServerId=${a.server.id}`);

      fake.next(() => ({ status: 204 }));
      assert.equal((await a.owner.send("DELETE", path)).status, 204);
      assert.equal(fake.requests.at(-1)!.method, "DELETE");
      const disconnects = await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "agent_connection.disconnected"));
      assert.equal(disconnects.filter((row) => row.targetId === created.id).length, 1);

      // The provider answers unknown routes and unknown agents alike with 404
      // `not_found`, so a connections 404 is classified by looking the agent up.
      const agentLookupPath = `/provision/agents/by-raft-agent/${created.id}?raftServerId=${a.server.id}`;
      const routeMissing = { status: 404, body: { error: { code: "not_found", message: "route is not part of raft-agent-provider.v1" } } };
      const isAgentLookup = (request: Recorded) => request.method === "GET" && request.path === agentLookupPath;

      // Connections 404 + agent lookup 200: the agent exists, the connections route does not → unsupported.
      fake.setFallback((request) => isAgentLookup(request) ? { status: 200, body: { providerAgentId: `raft_${created.id}`, status: "active" } } : routeMissing);
      let before = fake.requests.length;
      const unsupported = await a.owner.get(path);
      assert.equal(unsupported.status, 200);
      assert.deepEqual(await unsupported.json(), { provider: "github", supported: false });
      assert.deepEqual(fake.requests.slice(before).map((r) => `${r.method} ${r.path}`), [
        `GET /provision/agents/by-raft-agent/${created.id}/connections/github?raftServerId=${a.server.id}`,
        `GET ${agentLookupPath}`,
      ], "exactly one follow-up agent lookup");
      const startUnsupported = await a.owner.send("POST", path, {});
      assert.equal(startUnsupported.status, 409);
      assert.equal((await startUnsupported.json() as { code: string }).code, "agent_connection_unsupported");

      // Connections 404 + agent lookup 404: the provider no longer knows the agent (stale provisioning).
      const missingMessage = `no provisioned agent made from Raft agent ${created.id}`;
      fake.setFallback((request) => isAgentLookup(request) ? { status: 404, body: { error: { code: "not_found", message: missingMessage } } } : routeMissing);
      for (const method of ["GET", "POST"] as const) {
        before = fake.requests.length;
        const res = method === "GET" ? await a.owner.get(path) : await a.owner.send("POST", path, {});
        assert.equal(res.status, 409, method);
        assert.deepEqual(await res.json(), {
          error: "This agent no longer exists at its provider; connections are unavailable. Recreate the agent.",
          code: "agent_connection_agent_missing_at_provider",
          providerMessage: missingMessage,
        }, method);
        assert.equal(fake.requests.slice(before).filter(isAgentLookup).length, 1, `${method}: one agent lookup`);
      }

      // Connections 404 + agent lookup failing: that call's error, not a guess.
      fake.setFallback((request) => isAgentLookup(request) ? { status: 503, body: { error: { code: "down", message: "later" } } } : routeMissing);
      assert.equal((await a.owner.get(path)).status, 502);

      // Non-404 connection errors never trigger the lookup.
      before = fake.requests.length;
      fake.setFallback(() => ({ status: 503, body: { error: { code: "down", message: "later" } } }));
      assert.equal((await a.owner.send("POST", path, {})).status, 502);
      assert.equal(fake.requests.slice(before).filter(isAgentLookup).length, 0);

      // A plain external agent (no provider) is not provider-backed.
      const plainRes = await a.owner.send("POST", "/agents", { name: "plain-external", external: true });
      const plain = await plainRes.json() as { id: string };
      assert.equal(plainRes.status, 200, JSON.stringify(plain));
      const connectionsBefore = connectionRequests(fake).length;
      const refused = await a.owner.send("POST", `/agents/${plain.id}/connections/github`, {});
      assert.equal(refused.status, 400);
      assert.equal((await refused.json() as { code: string }).code, "agent_connection_not_provider_backed");
      assert.equal(connectionRequests(fake).length, connectionsBefore);

      // Another server cannot address the agent.
      const b = await setupServer(app.baseUrl, "conn-status-b");
      assert.equal((await b.owner.get(path)).status, 404);
    } finally {
      await fake.close();
    }
  });
});

test("the provider return lands on the API origin and is forwarded to the web landing page", async ({ app }) => {
  const serverId = randomUUID();
  const agentId = randomUUID();
  const by = randomUUID();
  const res = await fetch(`${app.baseUrl}/api/connections/callback/${serverId}/${agentId}?connection=github&status=pending&pending=pnd_abc-123&by=${by}&extra=x`, { redirect: "manual" });
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get("location")!);
  assert.equal(location.pathname, "/connections/callback");
  assert.deepEqual(Object.fromEntries(location.searchParams), { connection: "github", status: "pending", pending: "pnd_abc-123", by, serverId, agentId });
  // A bare "connected" is not an outcome any more: only a confirmed pending id attaches a connection.
  const legacy = new URL(buildAgentConnectionLandingUrl({ serverId, agentId, query: { connection: "github", status: "connected", pending: "x" } })!);
  assert.deepEqual(Object.fromEntries(legacy.searchParams), { connection: "github", status: "failed", serverId, agentId });
  assert.equal((await fetch(`${app.baseUrl}/api/connections/callback/nope/${agentId}`, { redirect: "manual" })).status, 404);
  const odd = new URL(buildAgentConnectionLandingUrl({ serverId, agentId, query: { connection: "gitlab", status: "pwned", by: "<script>" } })!);
  assert.deepEqual(Object.fromEntries(odd.searchParams), { status: "failed", serverId, agentId });
});

test("confirming a pending connection re-checks permission and sends the session user, not the query `by`", async ({ app }) => {
  await withEnv(async () => {
    const fake = await startFakeProvider();
    try {
      const a = await setupConnectionServer(app.baseUrl, "conn-confirm");
      await configure(fake, a);
      const created = await createHosted(a.owner, "conn-confirm-agent");
      await drainAgentRuntimeProvisions();
      await getDb().update(agents).set({ creatorType: "user", creatorId: a.creatorUser.id }).where(eq(agents.id, created.id));
      const path = `/agents/${created.id}/connections/github/confirm`;
      const confirmPath = `/provision/agents/by-raft-agent/${created.id}/connections/github/confirm?raftServerId=${a.server.id}`;
      fake.setFallback((request) => {
        if (request.method !== "POST" || request.path !== confirmPath) return { status: 500 };
        const body = JSON.parse(request.body) as { pending: string; raftUserId: string };
        if (body.pending !== "pnd_ok" || body.raftUserId !== a.creatorUser.id) {
          return { status: 404, body: { error: { code: "not_found", message: "expired, used or mismatched" } } };
        }
        return { status: 200, body: { connected: true, connectorId: "ctr_new", account: "octocat", connectedAt: "2026-09-29T00:00:00.000Z", connectedBy: a.creatorUser.id } };
      });

      for (const client of [a.member, a.guest]) {
        assert.equal((await client.send("POST", path, { pending: "pnd_ok", by: a.creatorUser.id })).status, 403);
      }
      assert.equal(connectionRequests(fake).length, 0, "no confirm call without permission");
      assert.equal((await a.creator.send("POST", path, {})).status, 400);

      const ok = await a.creator.send("POST", path, { pending: "pnd_ok" });
      const okBody = await ok.json() as { connected: boolean; account: string; connectedBy: { id: string }; connectorId: string };
      assert.equal(ok.status, 200, JSON.stringify(okBody));
      assert.equal(okBody.connected, true);
      assert.equal(okBody.connectorId, "ctr_new", "confirm creates a tenant connector and returns its id");
      assert.equal(okBody.account, "octocat");
      assert.equal(okBody.connectedBy.id, a.creatorUser.id);
      const sent = JSON.parse(connectionRequests(fake).at(-1)!.body) as Record<string, unknown>;
      assert.deepEqual(sent, { pending: "pnd_ok", raftUserId: a.creatorUser.id });

      // The owner cannot complete the creator's flow: the provider sees the owner's id and refuses.
      const foreign = await a.owner.send("POST", path, { pending: "pnd_ok", raftUserId: a.creatorUser.id });
      assert.equal(foreign.status, 404);
      assert.equal((await foreign.json() as { code: string }).code, "agent_connection_pending_invalid");
      assert.notEqual((JSON.parse(connectionRequests(fake).at(-1)!.body) as { raftUserId: string }).raftUserId, a.creatorUser.id);

      const expired = await a.creator.send("POST", path, { pending: "pnd_expired" });
      assert.equal(expired.status, 404);
      assert.equal((await expired.json() as { code: string }).code, "agent_connection_pending_invalid");

      const before = connectionRequests(fake).length;
      assert.equal((await a.creator.send("POST", path, { pending: "bad id/../x" })).status, 404, "malformed pending ids never reach the provider");
      assert.equal(connectionRequests(fake).length, before);

      const audits = await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "agent_connection.confirmed"));
      const confirmed = audits.filter((row) => row.targetId === created.id && row.outcome === "success");
      assert.equal(confirmed.length, 1);
      assert.equal((confirmed[0]!.metadata as { connectorId?: string }).connectorId, "ctr_new");
    } finally {
      await fake.close();
    }
  });
});

test("a provider refusal (4xx) surfaces its sanitized reason on connect and confirm", async ({ app }) => {
  await withEnv(async () => {
    const fake = await startFakeProvider();
    try {
      const a = await setupConnectionServer(app.baseUrl, "conn-refused");
      await configure(fake, a);
      const created = await createHosted(a.owner, "conn-refused-agent");
      await drainAgentRuntimeProvisions();
      const reason = "Agent has no github plugin mount; add exactly one. token ghp_abcdef0123456789 Bearer secret-value";
      fake.setFallback(() => ({ status: 409, body: { error: { code: "github_mount_missing", message: reason } } }));

      for (const [path, body] of [
        [`/agents/${created.id}/connections/github`, {}],
        [`/agents/${created.id}/connections/github/confirm`, { pending: "pnd_ok" }],
      ] as const) {
        const res = await a.owner.send("POST", path, body);
        const text = await res.text();
        assert.equal(res.status, 409, text);
        const json = JSON.parse(text) as { code: string; providerCode: string; providerMessage: string; error: string };
        assert.equal(json.code, "agent_connection_provider_refused");
        assert.equal(json.providerCode, "github_mount_missing");
        assert.match(json.providerMessage, /^Agent has no github plugin mount; add exactly one\./);
        assert.equal(json.error, json.providerMessage);
        assert.ok(!text.includes("ghp_abcdef0123456789") && !text.includes("secret-value"), "token-shaped text is redacted");
        assert.ok(!text.includes(PROVIDER_TOKEN));
      }

      // Confirm 404 keeps its own code but still carries the provider's reason.
      fake.setFallback(() => ({ status: 404, body: { error: { code: "pending_expired", message: "The pending connection expired." } } }));
      const expired = await a.owner.send("POST", `/agents/${created.id}/connections/github/confirm`, { pending: "pnd_old" });
      assert.equal(expired.status, 404);
      assert.deepEqual(
        await expired.json(),
        { error: "The connection link expired or is invalid; start again", code: "agent_connection_pending_invalid", providerCode: "pending_expired", providerMessage: "The pending connection expired." },
      );
    } finally {
      await fake.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Tenant connectors: one server-level GitHub connection shared by several agents
// ---------------------------------------------------------------------------

async function setupConnectorServer(baseUrl: string, slug: string) {
  const a = await setupConnectionServer(baseUrl, slug);
  const idOf = async (email: string) => (await getDb().select({ id: users.id }).from(users).where(eq(users.email, email)))[0]!.id;
  return {
    ...a,
    ownerId: await idOf(`${slug}-owner@raft.test`),
    adminId: await idOf(`${slug}-admin@raft.test`),
    memberId: await idOf(`${slug}-member@raft.test`),
  };
}

test("connection status lists the server's connectors with resolved creators, per-caller authority and never a token", async ({ app }) => {
  await withEnv(async () => {
    const fake = await startFakeProvider();
    try {
      const a = await setupConnectorServer(app.baseUrl, "conn-list");
      await configure(fake, a);
      const created = await createHosted(a.owner, "conn-list-agent");
      await drainAgentRuntimeProvisions();
      await getDb().update(agents).set({ creatorType: "user", creatorId: a.creatorUser.id }).where(eq(agents.id, created.id));
      const outsider = await seedUser("conn-list-outsider@raft.test", "conn-list-outsider");
      fake.setFallback(() => ({
        status: 200,
        body: {
          connected: true,
          connectorId: "ctr_mine",
          account: "octocat",
          connectedAt: "2026-09-29T00:00:00.000Z",
          connectedBy: a.creatorUser.id,
          token: "ghp_toplevelsecret0123456789",
          connectors: [
            { id: "ctr_mine", account: "octocat", creatorRaftUserId: a.creatorUser.id, createdAt: "2026-09-29T00:00:00.000Z", current: true, accessToken: "ghp_mysecret0123456789" },
            { id: "ctr_admin", account: "hubot", creatorRaftUserId: a.adminId, createdAt: "2026-09-28T00:00:00.000Z", current: false },
            { id: "ctr_gone", account: "ex", creatorRaftUserId: outsider.id, createdAt: null, current: false },
            { id: "bad id/..", account: "x", creatorRaftUserId: a.adminId },
            "junk",
          ],
        },
      }));
      const path = `/agents/${created.id}/connections/github`;

      const res = await a.creator.get(path);
      const text = await res.text();
      assert.equal(res.status, 200, text);
      assert.ok(!text.includes("ghp_"), "no provider token field is passed through");
      const body = JSON.parse(text) as { connectorId: string; connectors: unknown[] };
      assert.equal(body.connectorId, "ctr_mine");
      assert.deepEqual(body.connectors, [
        { id: "ctr_mine", account: "octocat", createdAt: "2026-09-29T00:00:00.000Z", creator: { id: a.creatorUser.id, name: "conn-list-creator", displayName: "conn-list-creator" }, current: true, canManage: true },
        { id: "ctr_admin", account: "hubot", createdAt: "2026-09-28T00:00:00.000Z", creator: { id: a.adminId, name: "conn-list-admin", displayName: "conn-list-admin" }, current: false, canManage: false },
        // Not a member of this server: no name is resolved.
        { id: "ctr_gone", account: "ex", createdAt: null, creator: { id: outsider.id, name: null, displayName: null }, current: false, canManage: false },
      ]);

      const asAdmin = await (await a.admin.get(path)).json() as { connectors: { id: string; canManage: boolean }[] };
      assert.deepEqual(asAdmin.connectors.map((c) => c.canManage), [true, true, true], "owner/admin may manage every connector");
    } finally {
      await fake.close();
    }
  });
});

test("switching an agent's connector and disconnecting a connector need the connector's creator or an owner/admin", async ({ app }) => {
  await withEnv(async () => {
    const fake = await startFakeProvider();
    try {
      const a = await setupConnectorServer(app.baseUrl, "conn-assign");
      await configure(fake, a);
      const created = await createHosted(a.owner, "conn-assign-agent");
      await drainAgentRuntimeProvisions();
      // The member "creator" owns the agent, so it may manage it but only its own connectors.
      await getDb().update(agents).set({ creatorType: "user", creatorId: a.creatorUser.id }).where(eq(agents.id, created.id));
      const statusPath = `/provision/agents/by-raft-agent/${created.id}/connections/github?raftServerId=${a.server.id}`;
      const connectors = [
        { id: "ctr_creator", account: "octocat", creatorRaftUserId: a.creatorUser.id, createdAt: "2026-09-29T00:00:00.000Z", current: false },
        { id: "ctr_admin", account: "hubot", creatorRaftUserId: a.adminId, createdAt: "2026-09-29T00:00:00.000Z", current: false },
        { id: "ctr_member", account: "monalisa", creatorRaftUserId: a.memberId, createdAt: "2026-09-29T00:00:00.000Z", current: false },
        { id: "ctr_guest", account: "ghost", creatorRaftUserId: a.guestUser.id, createdAt: "2026-09-29T00:00:00.000Z", current: false },
      ];
      fake.setFallback((request) => {
        if (request.method === "GET" && request.path === statusPath) return { status: 200, body: { connected: false, connectorId: null, account: null, connectors } };
        if (request.method === "PUT" && request.path === statusPath) return { status: 200, body: {} };
        if (request.method === "DELETE" && request.path.startsWith("/provision/connectors/")) return { status: 204 };
        return { status: 500, body: { error: { code: "unexpected", message: `${request.method} ${request.path}` } } };
      });
      const agentPath = `/agents/${created.id}/connections/github`;
      const mutations = () => fake.requests.filter((r) => r.method === "PUT" || (r.method === "DELETE" && r.path.startsWith("/provision/connectors/")));
      const assign = (client: ReturnType<typeof api>, connectorId: unknown) => client.send("PUT", agentPath, { connectorId });
      const disconnect = (client: ReturnType<typeof api>, connectorId: string) => client.send("DELETE", `${agentPath}/connectors/${connectorId}`);

      // Refused: never reaches the provider's mutating routes.
      // Guests are refused before the route (guest gate), so no route code is asserted for them.
      const refusals: [string, () => Promise<Response>, number, string | null][] = [
        ["agent creator, someone else's connector (PUT)", () => assign(a.creator, "ctr_admin"), 403, "agent_connection_connector_forbidden"],
        ["agent creator, someone else's connector (DELETE)", () => disconnect(a.creator, "ctr_admin"), 403, "agent_connection_connector_forbidden"],
        ["connector creator who cannot manage the agent (PUT)", () => assign(a.member, "ctr_member"), 403, "agent_connection_forbidden"],
        ["connector creator who cannot manage the agent (DELETE)", () => disconnect(a.member, "ctr_member"), 403, "agent_connection_forbidden"],
        ["guest (PUT)", () => assign(a.guest, "ctr_guest"), 403, null],
        ["guest (DELETE)", () => disconnect(a.guest, "ctr_guest"), 403, null],
        ["unknown connector (PUT)", () => assign(a.owner, "ctr_nope"), 404, "agent_connection_connector_not_found"],
        ["unknown connector (DELETE)", () => disconnect(a.owner, "ctr_nope"), 404, "agent_connection_connector_not_found"],
        ["missing connectorId", () => assign(a.owner, undefined), 400, "agent_connection_invalid"],
      ];
      for (const [label, call, status, code] of refusals) {
        const res = await call();
        const json = await res.json() as { code: string; error: string };
        assert.equal(res.status, status, `${label}: ${JSON.stringify(json)}`);
        if (code) assert.equal(json.code, code, label);
        if (code === "agent_connection_connector_forbidden") assert.match(json.error, /creator or a server admin/);
      }
      // A guest who created both the agent and the connector is still refused.
      await getDb().update(agents).set({ creatorId: a.guestUser.id }).where(eq(agents.id, created.id));
      assert.equal((await assign(a.guest, "ctr_guest")).status, 403, "guest creator");
      await getDb().update(agents).set({ creatorId: a.creatorUser.id }).where(eq(agents.id, created.id));
      assert.equal(mutations().length, 0, "refused callers never reach the provider");

      // Allowed: the acting role Raft vouches for goes to the provider.
      const allowed: [string, ReturnType<typeof api>, string, string, string][] = [
        ["connector creator", a.creator, "ctr_creator", a.creatorUser.id, "creator"],
        ["admin, own connector", a.admin, "ctr_admin", a.adminId, "creator"],
        ["admin, other's connector", a.admin, "ctr_creator", a.adminId, "admin"],
        ["owner", a.owner, "ctr_member", a.ownerId, "admin"],
      ];
      for (const [label, client, connectorId, actingRaftUserId, actingRole] of allowed) {
        const put = await assign(client, connectorId);
        const putBody = await put.json() as { supported: boolean; connectors: unknown[] };
        assert.equal(put.status, 200, `${label}: ${JSON.stringify(putBody)}`);
        assert.equal(putBody.connectors.length, connectors.length, `${label}: returns the refreshed status`);
        assert.deepEqual(JSON.parse(mutations().at(-1)!.body), { connectorId, actingRaftUserId, actingRole }, label);

        const del = await disconnect(client, connectorId);
        assert.equal(del.status, 204, label);
        const sent = mutations().at(-1)!;
        assert.equal(sent.path, `/provision/connectors/${connectorId}?raftServerId=${a.server.id}`);
        assert.deepEqual(JSON.parse(sent.body), { actingRaftUserId, actingRole }, label);
      }

      // Partial failure: the provider could not detach some agents (502 + `failed`). Not a success; retrying the same call completes it.
      let partialOnce = true;
      fake.setFallback((request) => {
        if (request.method === "GET" && request.path === statusPath) return { status: 200, body: { connected: false, connectors } };
        if (request.method === "DELETE" && request.path.startsWith("/provision/connectors/")) {
          if (partialOnce) {
            partialOnce = false;
            return { status: 502, body: { error: { code: "partial", message: "some agents were not detached" }, failed: [randomUUID(), randomUUID()] } };
          }
          return { status: 204 };
        }
        return { status: 500 };
      });
      const partial = await disconnect(a.owner, "ctr_admin");
      assert.equal(partial.status, 502);
      assert.deepEqual(await partial.json(), {
        error: "Disconnect partially completed; retry to finish",
        code: "agent_connection_connector_disconnect_partial",
        failedCount: 2,
      });
      assert.equal((await disconnect(a.owner, "ctr_admin")).status, 204, "retry completes the cleanup");
      const partialAudits = await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "agent_connection.connector_disconnected"));
      assert.equal(partialAudits.filter((row) => row.targetId === created.id && row.outcome === "failure").length, 1);
      fake.setFallback((request) => {
        if (request.method === "GET" && request.path === statusPath) return { status: 200, body: { connected: false, connectorId: null, account: null, connectors } };
        return { status: 204 };
      });

      // Agent-level DELETE only detaches this agent (the existing rule, no connector check).
      fake.next(() => ({ status: 204 }));
      assert.equal((await a.creator.send("DELETE", agentPath)).status, 204);
      assert.equal(fake.requests.at(-1)!.path, statusPath);

      // The connector vanished between the lookup and the PUT: provider 404 + agent still there.
      fake.setFallback((request) => {
        if (request.method === "GET" && request.path === statusPath) return { status: 200, body: { connected: false, connectors } };
        if (request.method === "GET") return { status: 200, body: { providerAgentId: `raft_${created.id}` } };
        return { status: 404, body: { error: { code: "not_found", message: "no connector" } } };
      });
      const raced = await assign(a.owner, "ctr_creator");
      assert.equal(raced.status, 404);
      assert.equal((await raced.json() as { code: string }).code, "agent_connection_connector_not_found");

      const audits = await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.targetId, created.id));
      const assigned = audits.filter((row) => row.eventType === "agent_connection.connector_assigned" && row.outcome === "success");
      const disconnected = audits.filter((row) => row.eventType === "agent_connection.connector_disconnected" && row.outcome === "success");
      assert.equal(assigned.length, 4);
      assert.equal(disconnected.length, 5, "four in the matrix plus the completed retry");
      assert.deepEqual(assigned.map((row) => (row.metadata as { actingRole: string }).actingRole).sort(), ["admin", "admin", "creator", "creator"]);
    } finally {
      await fake.close();
    }
  });
});
