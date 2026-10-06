// Real-PostgreSQL concurrency teeth for the probe foundation (task #32).
// PGlite serializes transactions on one connection, so create/claim/receipt
// races can only be proven against a real multi-connection Postgres. CI runs
// this through `pnpm --filter @botiverse/raft-server test:probe-concurrency-real-pg`
// (wired into the hosted test workflow); locally: docker postgres + the same env.
import assert from "node:assert/strict";
import { createCipheriv, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import {
  PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
  mintProviderProbeId,
  providerProbeAuthorityIdentity,
  providerProbeRequestDigest,
  providerProbeResultDigest,
  sha256Hex,
  utf8ByteLength,
  type ProviderProbeId,
} from "@botiverse/raft-shared";
import { closeDatabase, getDb, initDatabase } from "../db/index";
import {
  featureFlagRules,
  machines,
  providerConnections,
  providerConnectionCredentials,
  providerProbeIntents,
  providerProbeReceipts,
  servers,
  users,
} from "../db/schema";
import {
  consumeProviderProbeResult,
  createProviderProbe,
  materializeProviderProbe,
  type ProbeCarrier,
  type ProbeCarrierFact,
} from "./providerProbeService";

const REAL_PG_URL = process.env.PROBE_CONCURRENCY_REAL_PG_URL;
const REAL_PG_REQUIRED = process.env.PROBE_CONCURRENCY_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const AUTHORITY = { connectionEpochId: "epoch-realpg-1", replicaGeneration: "gen-realpg-1" };
const FACT: ProbeCarrierFact = {
  capabilities: ["provider-probe:v1"],
  connectionEpochId: AUTHORITY.connectionEpochId,
  replicaGeneration: AUTHORITY.replicaGeneration,
  daemonVersion: "daemon-realpg",
  computerVersion: "computer-realpg",
  runtimes: ["builtin"],
  runtimeVersions: { builtin: "pi-realpg" },
};

async function withRealPg(run: () => Promise<void>): Promise<void> {
  if (!REAL_PG_URL) {
    if (REAL_PG_REQUIRED) throw new Error("PROBE_CONCURRENCY_REAL_PG_REQUIRED=1 but PROBE_CONCURRENCY_REAL_PG_URL is unset");
    return;
  }
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 31).toString("base64");
  const pool = new pg.Pool({ connectionString: REAL_PG_URL, max: 12 });
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  await initDatabase(REAL_PG_URL);
  try {
    await run();
  } finally {
    await closeDatabase();
    await pool.end();
  }
}

async function seed() {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const [user] = await db.insert(users).values({
    email: `realpg-${suffix}@raft.test`,
    name: `realpg-${suffix}`,
    displayName: "realpg",
    passwordHash: "x",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const [server] = await db.insert(servers).values({
    name: `realpg-server-${suffix}`,
    slug: `realpg-${suffix}`,
    ownerId: user.id,
  }).returning();
  const [connection] = await db.insert(providerConnections).values({
    serverId: server.id,
    name: `realpg-connection-${suffix}`,
    providerId: "deepseek",
    createdByUserId: user.id,
    updatedByUserId: user.id,
  }).returning();
  const key = Buffer.from(process.env.SLOCK_PROVIDER_CREDENTIAL_KEY!, "base64");
  const scope = `${server.id}:${connection.id}`;
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(scope, "utf8"));
  const encrypted = Buffer.concat([cipher.update("realpg-secret-key", "utf8"), cipher.final()]);
  await db.insert(providerConnectionCredentials).values({
    serverId: server.id,
    connectionId: connection.id,
    encryptedApiKey: [
      "v1",
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      encrypted.toString("base64url"),
    ].join(":"),
  });
  const [machine] = await db.insert(machines).values({
    serverId: server.id,
    userId: user.id,
    name: `realpg-machine-${suffix}`,
    apiKeyHash: "unused-realpg-hash",
    runtimes: ["builtin"],
  }).returning();
  for (const flagKey of [PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY]) {
    await db.insert(featureFlagRules).values({
      id: randomUUID(),
      flagKey,
      stage: "server",
      priority: -100,
      decision: "allow",
      values: [server.id],
    });
  }
  return { server, connection, machine, user };
}

function countingCarrier(dispatches: Array<{ probeId: string; requestId: string }>): ProbeCarrier {
  return {
    readFact: async () => FACT,
    dispatch: async (_machineId, command) => {
      dispatches.push({ probeId: command.probeId, requestId: command.requestId });
      // Resolve as a carrier timeout shortly after the transaction window so
      // the race under test is the advisory-lock/transaction window, not the
      // carrier latency, while still letting create() return.
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { kind: "timeout" as const };
    },
  };
}

async function createProbeArgs(seedResult: Awaited<ReturnType<typeof seed>>, overrides: Record<string, unknown> = {}) {
  const payload = {
    computerId: seedResult.machine.id,
    runtime: "builtin",
    model: "deepseek/deepseek-v4-pro",
    probeKind: "canary" as const,
    ...overrides,
  };
  return {
    serverId: seedResult.server.id,
    userId: seedResult.user.id,
    connectionId: seedResult.connection.id,
    probeRequestId: `probe-req-${randomUUID()}`,
    requestDigest: await providerProbeRequestDigest({
      connectionId: seedResult.connection.id,
      computerId: payload.computerId as string,
      runtime: payload.runtime as string,
      model: payload.model as string,
      probeKind: payload.probeKind as "canary",
    }),
    ...payload,
    expiresAt: new Date(Date.now() + 60_000),
  };
}

test("real PG: concurrent creates for one pair dispatch at most once", async () => {
  await withRealPg(async () => {
    const seeded = await seed();
    const dispatches: Array<{ probeId: string; requestId: string }> = [];
    const carrier = countingCarrier(dispatches);
    const [first, second] = await Promise.allSettled([
      createProviderProbe({ ...(await createProbeArgs(seeded)), carrier }),
      createProviderProbe({ ...(await createProbeArgs(seeded)), carrier }),
    ]);
    assert.equal(dispatches.length, 1, "different idempotency keys must not both dispatch");
    const fulfilled = [first, second].filter((entry) => entry.status === "fulfilled");
    assert.equal(fulfilled.length, 1);
    const rejected = [first, second].find((entry) => entry.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.match(String(rejected.reason), /rate limit|already pending/i);
  });
});

test("real PG: concurrent same-key creates replay exactly one probe", async () => {
  await withRealPg(async () => {
    const seeded = await seed();
    const dispatches: Array<{ probeId: string; requestId: string }> = [];
    const carrier = countingCarrier(dispatches);
    const args = await createProbeArgs(seeded);
    const [first, second] = await Promise.allSettled([
      createProviderProbe({ ...args, carrier }),
      createProviderProbe({ ...args, carrier }),
    ]);
    assert.equal(dispatches.length, 1, "same key must dispatch once");
    const views = [first, second].map((entry) => (
      entry.status === "fulfilled" ? entry.value.probe.probeId : null
    ));
    assert.equal(new Set(views).size, 1, "both callers observe the same probe");
  });
});

test("real PG: concurrent materialization claims produce exactly one winner", async () => {
  await withRealPg(async () => {
    const seeded = await seed();
    const [row] = await getDb().select({
      configVersion: providerConnections.configVersion,
      credentialVersion: providerConnectionCredentials.credentialVersion,
    }).from(providerConnections).innerJoin(providerConnectionCredentials, eq(
      providerConnectionCredentials.connectionId, providerConnections.id,
    )).where(eq(providerConnections.id, seeded.connection.id)).limit(1);
    const probeId = mintProviderProbeId();
    await getDb().insert(providerProbeIntents).values({
      id: probeId,
      serverId: seeded.server.id,
      connectionId: seeded.connection.id,
      configVersion: row!.configVersion,
      credentialVersion: row!.credentialVersion,
      computerId: seeded.machine.id,
      runtime: "builtin",
      model: "deepseek/deepseek-v4-pro",
      probeKind: "canary",
      probeRequestId: `probe-req-${randomUUID()}`,
      requestDigest: `digest-${randomUUID()}`,
      intentDigest: `intent-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
      dispatchedAt: new Date(),
      dispatchRequestId: "realpg-dispatch",
      dispatchEpochId: AUTHORITY.connectionEpochId,
      dispatchGeneration: AUTHORITY.replicaGeneration,
      capabilityObserved: true,
      dispatchDaemonVersion: "daemon-realpg",
      dispatchComputerVersion: "computer-realpg",
      dispatchRuntimeVersion: "pi-realpg",
      dispatchRuntimes: ["builtin"],
    });

    // The exact claim (== frozen dispatchRequestId) is idempotent under
    // concurrency: every caller observes the same materialization.
    const raced = await Promise.allSettled(Array.from({ length: 8 }, () => materializeProviderProbe({
      serverId: seeded.server.id,
      probeId,
      machineId: seeded.machine.id,
      claimRequestId: "realpg-dispatch",
      fact: FACT,
    })));
    const fulfilled = raced.filter((entry) => entry.status === "fulfilled");
    assert.equal(fulfilled.length, 8, "the exact claim must be idempotent for every concurrent caller");
    const authorities = new Set(fulfilled.map((entry) => (
      entry.status === "fulfilled" ? JSON.stringify(entry.value.authority) : ""
    )));
    assert.equal(authorities.size, 1, "all callers observe the same materialization");
    // Wrong claim ids never receive credentials, concurrently or not.
    const wrong = await Promise.allSettled(Array.from({ length: 7 }, (_, index) => materializeProviderProbe({
      serverId: seeded.server.id,
      probeId,
      machineId: seeded.machine.id,
      claimRequestId: `wrong-claim-${index}`,
      fact: FACT,
    })));
    assert.equal(wrong.filter((entry) => entry.status === "fulfilled").length, 0, "wrong claim ids must get zero credentials");
    const [intent] = await getDb().select().from(providerProbeIntents).where(eq(providerProbeIntents.id, probeId));
    assert.ok(intent?.claimMachineId === seeded.machine.id);
    assert.equal(intent?.claimRequestId, "realpg-dispatch");
  });
});

test("real PG: concurrent identical results insert one receipt and never flip terminal state", async () => {
  await withRealPg(async () => {
    const seeded = await seed();
    const [row] = await getDb().select({
      configVersion: providerConnections.configVersion,
      credentialVersion: providerConnectionCredentials.credentialVersion,
    }).from(providerConnections).innerJoin(providerConnectionCredentials, eq(
      providerConnectionCredentials.connectionId, providerConnections.id,
    )).where(eq(providerConnections.id, seeded.connection.id)).limit(1);
    const probeId = mintProviderProbeId();
    await getDb().insert(providerProbeIntents).values({
      id: probeId,
      serverId: seeded.server.id,
      connectionId: seeded.connection.id,
      configVersion: row!.configVersion,
      credentialVersion: row!.credentialVersion,
      computerId: seeded.machine.id,
      runtime: "builtin",
      model: "deepseek/deepseek-v4-pro",
      probeKind: "canary",
      probeRequestId: `probe-req-${randomUUID()}`,
      requestDigest: `digest-${randomUUID()}`,
      intentDigest: `intent-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
      dispatchedAt: new Date(),
      dispatchRequestId: "realpg-dispatch-2",
      dispatchEpochId: AUTHORITY.connectionEpochId,
      dispatchGeneration: AUTHORITY.replicaGeneration,
      capabilityObserved: true,
      dispatchDaemonVersion: "daemon-realpg",
      dispatchComputerVersion: "computer-realpg",
      dispatchRuntimeVersion: "pi-realpg",
      dispatchRuntimes: ["builtin"],
    });
    await materializeProviderProbe({
      serverId: seeded.server.id,
      probeId,
      machineId: seeded.machine.id,
      claimRequestId: "realpg-dispatch-2",
      fact: FACT,
    });

    const reply = "OK";
    const responseSha256 = await sha256Hex(reply);
    const responseBytes = utf8ByteLength(reply);
    const resultDigestPromise = providerProbeResultDigest({
      outcome: "success",
      category: null,
      responseSha256,
      responseBytes,
      authorityIdentity: await providerProbeAuthorityIdentity(AUTHORITY),
    });
    const message = async (requestId: string) => ({
      type: "machine:provider_probe:result" as const,
      requestId,
      probeId: probeId as ProviderProbeId,
      outcome: "success" as const,
      category: null,
      latencyMs: 9,
      responseSha256,
      responseBytes,
      resultDigest: await resultDigestPromise,
      authorityEcho: AUTHORITY,
      daemonVersion: "daemon-realpg",
      computerVersion: "computer-realpg",
      runtimeVersion: "pi-realpg",
      reply,
    });
    const raced = await Promise.allSettled([
      consumeProviderProbeResult({ probeId, message: await message("realpg-dispatch-2") }),
      consumeProviderProbeResult({ probeId, message: await message("realpg-dispatch-2") }),
    ]);
    const receipts = await getDb().select().from(providerProbeReceipts)
      .where(eq(providerProbeReceipts.probeId, probeId));
    assert.equal(receipts.length, 1, "insert-once receipt under real concurrency");
    assert.equal(receipts[0]?.outcome, "success");
    const fulfilled = raced.filter((entry) => entry.status === "fulfilled");
    assert.ok(fulfilled.length >= 1);
    for (const entry of fulfilled) {
      if (entry.status === "fulfilled") assert.equal(entry.value.view.outcome, "success");
    }

    // A result from another dispatch must never close this intent.
    await assert.rejects(consumeProviderProbeResult({
      probeId,
      message: await message("some-other-dispatch"),
    }), /does not match this dispatch/);

    // A conflicting late result must be rejected and must not flip the receipt.
    const lateDigest = await providerProbeResultDigest({
      outcome: "failure",
      category: "auth",
      responseSha256: null,
      responseBytes: null,
      authorityIdentity: await providerProbeAuthorityIdentity(AUTHORITY),
    });
    await assert.rejects(consumeProviderProbeResult({
      probeId,
      message: {
        type: "machine:provider_probe:result",
        requestId: "realpg-dispatch-2",
        probeId: probeId as ProviderProbeId,
        outcome: "failure",
        category: "auth",
        latencyMs: 1,
        responseSha256: null,
        responseBytes: null,
        resultDigest: lateDigest,
        authorityEcho: AUTHORITY,
        daemonVersion: null,
        computerVersion: null,
        runtimeVersion: null,
        reply: null,
      },
    }), /already closed/);
    const after = await getDb().select().from(providerProbeReceipts)
      .where(eq(providerProbeReceipts.probeId, probeId));
    assert.equal(after.length, 1);
    assert.equal(after[0]?.outcome, "success");
  });
});
