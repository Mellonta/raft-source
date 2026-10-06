import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { cliChildEnv } from "../test/cliChildEnv";
import assert from "node:assert/strict";

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";

import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { traceAgentIdHash, traceServerIdHash } from "../tracing/traceIdentity";
import { agents, messages, serverMembers, users } from "../db/schema";
import { createAgent, assignMachine } from "../services/agentService";
import { addHuman, createChannel, getOrCreateThread } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { registerMachine } from "../services/machineService";
import { createServer } from "../services/serverService";
import { mintAgentCredential } from "../services/agentCredentialService";
import * as taskService from "../services/taskService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

const execFileAsync = promisify(execFile);
const cliEntry = fileURLToPath(new URL("../../../cli/src/index.ts", import.meta.url));

async function seedUser(email: string, name: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  return user;
}

async function seedSearchFixture() {
  const db = getDb();
  const owner = await seedUser("search-ref-owner@slock.test", "search-ref-owner");
  const speaker = await seedUser("search-ref-speaker@slock.test", "search-ref-speaker");
  const server = await createServer("Search Ref Server", "search-ref-server", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: speaker.id, role: "member" }).onConflictDoNothing();
  const agent = await createAgent(server.id, "search-ref-agent", { runtime: "codex" });
  const { machine, apiKey } = await registerMachine(server.id, owner.id, "search-ref-machine");
  await assignMachine(agent.id, machine.id);
  const channel = await createChannel(server.id, "search-ref-channel");

  const ownerMessage = await createMessage(channel.id, "user", owner.id, "memberref owner zebraneedle");
  const speakerMessage = await createMessage(channel.id, "user", speaker.id, "memberref speaker zebraneedle");

  return { owner, speaker, server, agent, apiKey, channel, ownerMessage, speakerMessage };
}

function machineHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function runSlockCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "@oxc-node/core/register", cliEntry, ...args], {
    env: cliChildEnv(env),
  });
}

async function createAgentProfileEnv(baseUrl: string, serverId: string, agentId: string): Promise<{
  env: Record<string, string>;
  cleanup: () => void;
}> {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-search-cli-profile-"));
  const { apiKey } = await mintAgentCredential({
    agentId,
    scopes: ["read"],
    name: "search-ref-cli",
    createdByUserId: null,
  });
  fs.writeFileSync(path.join(profileDir, "credential.json"), JSON.stringify({
    schemaVersion: 1,
    serverUrl: baseUrl,
    agentId,
    serverId,
    apiKey,
    scopes: ["read"],
  }));
  return {
    env: {
      RAFT_PROFILE: "cli-e2e",
      RAFT_PROFILE_DIR: profileDir,
    },
    cleanup: () => fs.rmSync(profileDir, { recursive: true, force: true }),
  };
}

test("internal agent search resolves sender handle refs and filters by sender", async ({ app }) => {
  const { speaker, agent, apiKey, speakerMessage, ownerMessage } = await seedSearchFixture();
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const params = new URLSearchParams({
    q: "zebraneedle",
    sender: `@${speaker.name}`,
  });

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/search?${params}`, {
    headers: machineHeaders(apiKey),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { results: Array<{ id: string; senderName: string; taskCurrentProjection?: unknown }> };
  assert.deepEqual(body.results.map((result) => result.id), [speakerMessage.id]);
  assert.equal(body.results.some((result) => result.id === ownerMessage.id), false);
  assert.equal(body.results[0]?.senderName, speaker.name);
  assert.equal(body.results[0]?.taskCurrentProjection, undefined);

  // Managed agents (machine key + :id) are traced by the agent's keyed hash,
  // on the request span and its search spans, never by the raw id.
  const agentHash = traceAgentIdHash(agent.id);
  assert.match(agentHash ?? "", /^[0-9a-f]{16}$/);
  const requestSpan = sink.getAllSpans().find((span) =>
    span.name === "server.http.request" && span.attrs?.route_pattern === "/internal/agent/:id/search"
  );
  assert.ok(requestSpan, "expected managed agent search request span");
  const childSpans = sink.getAllSpans().filter((span) =>
    span.context.traceId === requestSpan.context.traceId && span.name !== "server.http.request"
  );
  assert.ok(
    childSpans.some((span) => span.name === "server.db.query" && span.attrs?.query_name === "messages.search"),
    "expected the messages.search query span",
  );
  for (const span of [requestSpan, ...childSpans]) {
    assert.equal(span.attrs?.agent_id_hash, agentHash, `${span.name} should carry agent_id_hash`);
    assert.equal(span.attrs?.agent_id_present, true, `${span.name} should mark agent_id_present`);
    assert.equal(span.attrs?.server_id_hash, traceServerIdHash(agent.serverId), `${span.name} should carry server_id_hash`);
    assert.equal(JSON.stringify(span).includes(agent.id), false, `${span.name} must not carry the raw agent id`);
    assert.equal(JSON.stringify(span).includes(agent.serverId), false, `${span.name} must not carry the raw server id`);
  }
});

test("internal agent search preserves an amended task host hit and attaches its latest projection", async ({ app }) => {
  const { owner, agent, apiKey, channel, ownerMessage } = await seedSearchFixture();
  await addHuman(channel.id, owner.id);
  const hostMessage = await createMessage(
    channel.id,
    "user",
    owner.id,
    "supersessionneedle original premise",
  );
  const task = await taskService.convertMessageToTask(hostMessage.id, "user", owner.id, channel.id);
  assert.notEqual(typeof task, "string", String(task));
  if (typeof task === "string") return;
  assert.notEqual(typeof await taskService.amendTask(task.id, {
    title: "intermediate premise",
    description: "intermediate details",
  }, "user", owner.id), "string");
  const latest = await taskService.amendTask(task.id, {
    title: "final current premise",
    description: "final current details",
  }, "user", owner.id);
  assert.notEqual(typeof latest, "string", String(latest));
  if (typeof latest === "string") return;

  const params = new URLSearchParams({ q: "supersessionneedle" });
  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/search?${params}`, {
    headers: machineHeaders(apiKey),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { results: Array<Record<string, unknown>> };
  const hit = body.results.find((result) => result.id === hostMessage.id) as {
    content: string;
    taskNumber: number;
    taskCurrentProjection: Record<string, unknown>;
  } | undefined;
  assert.ok(hit);
  assert.equal(hit.content, "supersessionneedle original premise");
  assert.equal(hit.taskNumber, task.taskNumber);
  assert.deepEqual(hit.taskCurrentProjection, {
    title: "final current premise",
    description: "final current details",
    revision: latest.row.revision,
    superseded: true,
    amendedAt: latest.event.createdAt.toISOString(),
    amendedByType: "user",
    amendedByName: owner.name,
    source: "tasks_current_projection",
  });
  const ordinary = body.results.find((result) => result.id === ownerMessage.id);
  if (ordinary) assert.equal("taskCurrentProjection" in ordinary, false);
});

test("internal agent search projects thread reply hits with the thread channel id", async ({ app }) => {
  const { agent, apiKey, channel, owner } = await seedSearchFixture();
  const parent = await createMessage(channel.id, "user", owner.id, "thread parent without the regression token");
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  const firstReply = await createMessage(thread.id, "user", owner.id, "minimaxgrouping first reply");
  const secondReply = await createMessage(thread.id, "user", owner.id, "minimaxgrouping second reply");

  const params = new URLSearchParams({
    q: "minimaxgrouping",
    sort: "recent",
  });
  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/search?${params}`, {
    headers: machineHeaders(apiKey),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as {
    results: Array<{
      id: string;
      channelId: string;
      channelType: string;
      threadId: string | null;
      parentMessageId: string | null;
      parentMessageContent: string | null;
    }>;
  };

  const replyResults = body.results.filter((result) => result.id === firstReply.id || result.id === secondReply.id);
  assert.equal(replyResults.length, 2);
  assert.deepEqual(new Set(replyResults.map((result) => result.threadId)), new Set([thread.id]));
  assert.deepEqual(new Set(replyResults.map((result) => result.parentMessageId)), new Set([parent.id]));
  assert.deepEqual(new Set(replyResults.map((result) => result.channelType)), new Set(["thread"]));
  assert.deepEqual(new Set(replyResults.map((result) => result.channelId)), new Set([thread.id]));
  assert.equal(replyResults.every((result) => result.parentMessageContent === parent.content), true);
});

test("internal agent search reports invisible or unknown sender handles as member_not_found", async ({ app }) => {
  const invisible = await seedUser("search-ref-invisible@slock.test", "search-ref-invisible");
  const { agent, apiKey } = await seedSearchFixture();
  const params = new URLSearchParams({
    q: "zebraneedle",
    sender: `@${invisible.name}`,
  });

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/search?${params}`, {
    headers: machineHeaders(apiKey),
  });
  assert.equal(res.status, 404);
  const body = await res.json() as { errorCode?: string; error?: string };
  assert.equal(body.errorCode, "member_not_found");
  assert.match(body.error ?? "", /Member not found/);
});

test("internal agent search reports ambiguous human/agent sender handles", async ({ app }) => {
  const db = getDb();
  const { server, agent, apiKey } = await seedSearchFixture();
  const duplicateHuman = await seedUser("search-ref-dupe@slock.test", "search-ref-dupe");
  await db.insert(serverMembers).values({ serverId: server.id, userId: duplicateHuman.id, role: "member" }).onConflictDoNothing();
  await db.insert(agents).values({
    serverId: server.id,
    name: duplicateHuman.name,
    displayName: duplicateHuman.name,
    runtime: "codex",
    model: "sonnet",
  });

  const params = new URLSearchParams({
    q: "zebraneedle",
    sender: `@${duplicateHuman.name}`,
  });
  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/search?${params}`, {
    headers: machineHeaders(apiKey),
  });
  assert.equal(res.status, 409);
  const body = await res.json() as { errorCode?: string; error?: string };
  assert.equal(body.errorCode, "ambiguous_member_ref");
  assert.match(body.error ?? "", /ambiguous/);
});

test("internal agent search requires timezone offsets on direct date filters", async ({ app }) => {
  const { agent, apiKey } = await seedSearchFixture();
  const params = new URLSearchParams({
    q: "zebraneedle",
    after: "2026-08-06T04:38:36",
  });

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/search?${params}`, {
    headers: machineHeaders(apiKey),
  });

  assert.equal(res.status, 400);
  const body = await res.json() as { errorCode?: string; error?: string };
  assert.equal(body.errorCode, "INVALID_DATE_FILTER");
  assert.match(body.error ?? "", /missing a timezone offset/i);
  assert.match(body.error ?? "", /\+08:00/);
  assert.match(body.error ?? "", /raft CLI/);
});

test("internal agent search applies offset-bearing boundary filters as absolute instants", async ({ app }) => {
  const db = getDb();
  const { speaker, agent, apiKey, speakerMessage } = await seedSearchFixture();
  await db.update(messages)
    .set({ createdAt: new Date("2026-08-05T20:38:37.000Z") })
    .where(eq(messages.id, speakerMessage.id));

  async function searchWith(params: Record<string, string>): Promise<string[]> {
    const query = new URLSearchParams({
      q: "zebraneedle",
      sender: `@${speaker.name}`,
      sort: "recent",
      ...params,
    });
    const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/search?${query}`, {
      headers: machineHeaders(apiKey),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { results: Array<{ id: string }> };
    return body.results.map((result) => result.id);
  }

  assert.deepEqual(
    await searchWith({ after: "2026-08-06T04:38:36+08:00" }),
    [speakerMessage.id],
  );
  assert.deepEqual(
    await searchWith({ after: "2026-08-06T04:38:38+08:00" }),
    [],
  );
  assert.deepEqual(
    await searchWith({ before: "2026-08-06T04:38:38+08:00" }),
    [speakerMessage.id],
  );
  assert.deepEqual(
    await searchWith({ before: "2026-08-06T04:38:36+08:00" }),
    [],
  );
});

test("CLI e2e: slock message search --sender accepts member handles", async ({ app }) => {

  const profile = { cleanup: () => {} };
  try {
    const { speaker, server, agent } = await seedSearchFixture();
    const agentProfile = await createAgentProfileEnv(app.baseUrl, server.id, agent.id);
    profile.cleanup = agentProfile.cleanup;
    const { stdout, stderr } = await runSlockCli(
      ["message", "search", "--query", "zebraneedle", "--sender", `@${speaker.name}`],
      agentProfile.env,
    );

    assert.equal(stderr, "");
    assert.match(stdout, /<result ref="msg:[^"]+">/);
    assert.match(stdout, /Sender: search-ref-speaker \(human\)/);
    assert.doesNotMatch(stdout, /\bsender: @search-ref-speaker/);
    assert.match(stdout, /memberref speaker <match>zebraneedle<\/match>/);
    assert.doesNotMatch(stdout, /memberref owner zebraneedle/);
  } finally {
    profile.cleanup();
    await app.close();
  }
});
