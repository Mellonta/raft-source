// Real-PostgreSQL teeth for the hosted-runtime provisioning worker's single
// executor per Agent. PGlite serializes every transaction on one connection,
// so racing claims can only be proven against a real multi-connection
// Postgres. CI runs this through the hosted Test workflow
// (`pnpm --filter @botiverse/raft-server test:agent-runtime-provision-real-pg`);
// locally: docker postgres + the same env.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { closeDatabase, getDb, initDatabase } from "../db/index";
import { agentRuntimeProvisions, agents, servers, users } from "../db/schema";
import { __setAgentRuntimeProviderTransportForTests, encryptProviderSecret } from "./agentRuntimeProviderService";
import { claimProvision, drainAgentRuntimeProvisions } from "./agentRuntimeProvisionService";

const REAL_PG_URL = process.env.AGENT_RUNTIME_PROVISION_REAL_PG_URL;
const REAL_PG_REQUIRED = process.env.AGENT_RUNTIME_PROVISION_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

async function withRealPg(run: () => Promise<void>): Promise<void> {
  if (!REAL_PG_URL) {
    if (REAL_PG_REQUIRED) throw new Error("AGENT_RUNTIME_PROVISION_REAL_PG_REQUIRED=1 but AGENT_RUNTIME_PROVISION_REAL_PG_URL is unset");
    return;
  }
  const keys = ["SLOCK_PROVIDER_CREDENTIAL_KEY", "SERVER_URL", "ANTIPROTON_PROVISIONING_TOKEN"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 41).toString("base64");
  process.env.SERVER_URL = "https://raft.realpg.test";
  process.env.ANTIPROTON_PROVISIONING_TOKEN = "pt-realpg-token";
  const pool = new pg.Pool({ connectionString: REAL_PG_URL, max: 12 });
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  await initDatabase(REAL_PG_URL);
  try {
    await run();
  } finally {
    __setAgentRuntimeProviderTransportForTests(null);
    await closeDatabase();
    await pool.end();
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
}

async function seedProvision() {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const [user] = await db.insert(users).values({
    email: `arp-realpg-${suffix}@raft.test`,
    name: `arp-realpg-${suffix}`,
    displayName: "arp realpg",
    passwordHash: "x",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const [server] = await db.insert(servers).values({ name: `arp-${suffix}`, slug: `arp-${suffix}`, ownerId: user.id }).returning();
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: `arp-${suffix}`, runtime: "external", model: "external" }).returning();
  await db.insert(agentRuntimeProvisions).values({
    agentId: agent.id,
    serverId: server.id,
    provider: "antiproton",
    state: "provisioning",
    encryptedCredential: encryptProviderSecret(`sk_agent_${"a".repeat(64)}`, `agent-runtime-provision-credential:${agent.id}`),
    provisionedName: "arp",
    provisionedInstructions: "",
    nextAttemptAt: new Date(Date.now() - 1_000),
  });
  return agent.id;
}

test("racing claims on separate connections elect exactly one executor", async () => {
  await withRealPg(async () => {
    const agentId = await seedProvision();
    const now = new Date();
    const claims = await Promise.all(Array.from({ length: 10 }, (_, i) => claimProvision(agentId, `replica-${i}`, now)));
    const winners = claims.filter(Boolean);
    assert.equal(winners.length, 1);
    const [row] = await getDb().select().from(agentRuntimeProvisions).where(eq(agentRuntimeProvisions.agentId, agentId));
    assert.equal(row.leaseOwner, winners[0]!.leaseOwner);
    assert.equal(row.leaseGeneration, 1);
    assert.equal(row.attemptCount, 1);
  });
});

test("concurrent drains send the provider exactly one POST for one agent", async () => {
  await withRealPg(async () => {
    const agentId = await seedProvision();
    let posts = 0;
    __setAgentRuntimeProviderTransportForTests({
      baseUrl: "https://antiproton.realpg.test",
      fetch: (async (_input: unknown, init?: RequestInit) => {
        if (init?.method === "POST") posts += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return new Response(JSON.stringify({ providerAgentId: `raft_${agentId}`, push: { registered: true } }), { status: 201 });
      }) as typeof globalThis.fetch,
    });
    const summaries = await Promise.all(Array.from({ length: 6 }, (_, i) => drainAgentRuntimeProvisions({ leaseOwner: `drain-${i}` })));
    assert.equal(posts, 1);
    assert.equal(summaries.reduce((sum, s) => sum + s.succeeded, 0), 1);
    const [row] = await getDb().select().from(agentRuntimeProvisions).where(eq(agentRuntimeProvisions.agentId, agentId));
    assert.equal(row.state, "active");
    assert.equal(row.encryptedCredential, null);
    assert.equal(row.leaseOwner, null);
  });
});
