import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import {
  oauthClientInstalls,
  oauthClients,
  officialAppRegistry,
  officialAppAutoInstallStates,
  officialAppAutoInstallTransitions,
  servers,
  users,
} from "../db/schema";
import { getDb } from "../db/index";
import { createServer } from "./serverService";
import { createAgent } from "./agentService";
import {
  __setOfficialAppAutoInstallAttemptObserverForTests,
  __setBeforeOfficialAppAutoInstallWriteObserverForTests,
  getOfficialAppInstallationProvenance,
  reconcileOfficialDefaultAppForExistingServers,
} from "./officialAppAutoInstallService";

const test = createApiTest({ onboardingOpenerFlagDefaultEnabled: false });
const originalPublisherServerId = process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID;

afterEach(() => {
  if (originalPublisherServerId === undefined) delete process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID;
  else process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = originalPublisherServerId;
  __setOfficialAppAutoInstallAttemptObserverForTests(null);
  __setBeforeOfficialAppAutoInstallWriteObserverForTests(null);
});

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@raft.test`,
    name: `${label}-${randomUUID()}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

async function seedPublishedApp(input: {
  sourceServerId: string;
  createdByUserId: string;
  clientKey?: string;
}) {
  const clientKey = input.clientKey ?? "raft-artifacts";
  const [client] = await getDb().insert(oauthClients).values({
    serverId: input.sourceServerId,
    createdByUserId: input.createdByUserId,
    clientId: clientKey,
    clientSecretHash: createHash("sha256").update(randomUUID()).digest("hex"),
    appType: "third_party_global",
    enabled: true,
    publishStatus: "published",
    humanMarketplaceVisible: true,
    name: "Raft Artifacts",
    description: "Share durable artifacts",
  }).returning();
  return client;
}

async function seedRegistry(client: Awaited<ReturnType<typeof seedPublishedApp>>, input?: {
  autoInstall?: boolean;
  status?: "pending_review" | "approved" | "disabled";
  purpose?: string;
}) {
  const [entry] = await getDb().insert(officialAppRegistry).values({
    oauthClientId: client.id,
    clientKey: client.clientId,
    publisherServerId: client.serverId,
    autoInstall: input?.autoInstall ?? true,
    status: input?.status ?? "approved",
    purpose: input?.purpose ?? "Publish and retrieve durable Raft artifacts.",
  }).returning();
  return entry;
}

function humanHeaders(token: string, serverId: string) {
  return {
    Authorization: `Bearer ${token}`,
    "X-Server-Id": serverId,
    "Content-Type": "application/json",
  };
}

test("protected official trust root fails closed and third-party self-assertion cannot auto-install", async ({ app: _app }) => {
  const owner = await seedUser("official-fail-closed");
  const officialSource = await createServer("Official Source", `official-source-${randomUUID()}`, owner.id);
  const client = await seedPublishedApp({ sourceServerId: officialSource.id, createdByUserId: owner.id });
  await seedRegistry(client);
  const attemptedServerIds: string[] = [];
  __setOfficialAppAutoInstallAttemptObserverForTests((serverId) => attemptedServerIds.push(serverId));

  delete process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID;
  const missingTrustRootTarget = await createServer("Missing Root", `missing-root-${randomUUID()}`, owner.id);
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = randomUUID();
  const wrongTrustRootTarget = await createServer("Wrong Root", `wrong-root-${randomUUID()}`, owner.id);
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = "not-a-uuid";
  const invalidTrustRootTarget = await createServer("Invalid Root", `invalid-root-${randomUUID()}`, owner.id);
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = officialSource.id;
  __setBeforeOfficialAppAutoInstallWriteObserverForTests(() => {
    process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = randomUUID();
  });
  const staleApprovalTarget = await createServer("Stale Approval", `stale-approval-${randomUUID()}`, owner.id);
  __setBeforeOfficialAppAutoInstallWriteObserverForTests(null);
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = officialSource.id;
  __setBeforeOfficialAppAutoInstallWriteObserverForTests(async (_serverId, tx) => {
    await tx.update(officialAppRegistry).set({ purpose: "Policy changed before install.", revision: 2 })
      .where(eq(officialAppRegistry.oauthClientId, client.id));
  });
  const staleRegistryTarget = await createServer("Stale Registry", `stale-registry-${randomUUID()}`, owner.id);
  __setBeforeOfficialAppAutoInstallWriteObserverForTests(null);

  const installs = await getDb().select({ serverId: oauthClientInstalls.serverId })
    .from(oauthClientInstalls)
    .where(and(
      eq(oauthClientInstalls.clientId, client.id),
    ));
  assert.deepEqual(installs.filter(({ serverId }) => [
    missingTrustRootTarget.id,
    wrongTrustRootTarget.id,
    invalidTrustRootTarget.id,
    staleApprovalTarget.id,
    staleRegistryTarget.id,
  ].includes(serverId)), []);
  assert.deepEqual(attemptedServerIds, [staleApprovalTarget.id, staleRegistryTarget.id]);
});

test("unreviewed registry entries fail closed", async ({ app: _app }) => {
  const owner = await seedUser("official-reviewed-default");
  const source = await createServer("Botiverse", `botiverse-${randomUUID()}`, owner.id);
  const unreviewed = await seedPublishedApp({
    sourceServerId: source.id,
    createdByUserId: owner.id,
    clientKey: "unreviewed-official",
  });
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = source.id;
  await seedRegistry(unreviewed, { status: "pending_review" });
  let attempts = 0;
  __setOfficialAppAutoInstallAttemptObserverForTests(() => attempts += 1);

  const target = await createServer("Unreviewed Target", `unreviewed-target-${randomUUID()}`, owner.id);
  assert.equal(attempts, 0);
  assert.equal((await getDb().select().from(oauthClientInstalls).where(and(
    eq(oauthClientInstalls.serverId, target.id),
    eq(oauthClientInstalls.clientId, unreviewed.id),
  ))).length, 0);
});

test("Server provisioning auto-installs an official default with a unique system transition", async ({ app }) => {
  const owner = await seedUser("official-provision");
  const token = await tokenForHuman(owner.email);
  const source = await createServer("Botiverse", `botiverse-${randomUUID()}`, owner.id);
  const client = await seedPublishedApp({ sourceServerId: source.id, createdByUserId: owner.id });
  const existingTarget = await createServer("Existing Target", `existing-target-${randomUUID()}`, owner.id);
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = source.id;
  await seedRegistry(client);
  __setBeforeOfficialAppAutoInstallWriteObserverForTests(async (serverId, tx) => {
    if (serverId === existingTarget.id) return;
    await tx.update(oauthClients).set({ outboundCurrentGroups: ["server"] })
      .where(eq(oauthClients.id, client.id));
  });

  const target = await createServer("Target", `official-target-${randomUUID()}`, owner.id);
  __setBeforeOfficialAppAutoInstallWriteObserverForTests(null);
  const [install] = await getDb().select().from(oauthClientInstalls).where(and(
    eq(oauthClientInstalls.serverId, target.id),
    eq(oauthClientInstalls.clientId, client.id),
  ));
  assert.ok(install);
  assert.equal(install.installedBySystem, true);
  assert.equal(install.installedByUserId, null);
  assert.equal(install.installedByAgentId, null);
  assert.deepEqual(install.approvedGroups, ["server"], "write-point permission projection must use the fresh app revision");

  const provenance = await getOfficialAppInstallationProvenance(target.id, client.id);
  assert.equal(provenance?.installationId, install.id);
  assert.equal(provenance?.transitionSource, "auto_install");
  assert.equal(provenance?.actorType, "system");
  assert.equal(provenance?.revision, 1);

  const marketplace = await fetch(`${app.baseUrl}/api/integrations/marketplace`, {
    headers: humanHeaders(token, target.id),
  });
  assert.equal(marketplace.status, 200);
  const listing = (await marketplace.json() as Array<{ id: string; official: boolean; purpose: string }>)
    .find((candidate) => candidate.id === client.id);
  assert.equal(listing?.official, true);
  assert.equal(listing?.purpose, "Publish and retrieve durable Raft artifacts.");

  await reconcileOfficialDefaultAppForExistingServers({ clientKey: client.clientId, unknownState: "default_auto" });
  assert.equal((await getDb().select().from(oauthClientInstalls).where(and(
    eq(oauthClientInstalls.serverId, existingTarget.id),
    eq(oauthClientInstalls.clientId, client.id),
  ))).length, 1, "a product-approved default-set event installs on an existing Server");
  const transitions = await getDb().select().from(officialAppAutoInstallTransitions).where(and(
    eq(officialAppAutoInstallTransitions.serverId, target.id),
    eq(officialAppAutoInstallTransitions.clientId, client.id),
  ));
  assert.equal(transitions.length, 1, "duplicate default events must not create audit ambiguity");
});

test("explicit uninstall is sticky across rename and default reconciliation; user install alone clears it", async ({ app }) => {
  const owner = await seedUser("official-cycle");
  const token: string = await tokenForHuman(owner.email);
  const source = await createServer("Botiverse", `botiverse-${randomUUID()}`, owner.id);
  const client = await seedPublishedApp({ sourceServerId: source.id, createdByUserId: owner.id });
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = source.id;
  await seedRegistry(client);
  const target = await createServer("Cycle Target", `cycle-target-${randomUUID()}`, owner.id);

  const uninstall = await fetch(`${app.baseUrl}/api/integrations/marketplace/${client.id}/install`, {
    method: "DELETE",
    headers: humanHeaders(token, target.id),
  });
  assert.equal(uninstall.status, 200);
  await getDb().update(oauthClients).set({ name: "Raft Artifacts Renamed", updatedAt: new Date() })
    .where(eq(oauthClients.id, client.id));
  await reconcileOfficialDefaultAppForExistingServers({ clientKey: client.clientId, unknownState: "default_auto" });
  assert.equal((await getDb().select().from(oauthClientInstalls).where(and(
    eq(oauthClientInstalls.serverId, target.id),
    eq(oauthClientInstalls.clientId, client.id),
  ))).length, 0);

  const [suppressed] = await getDb().select().from(officialAppAutoInstallStates).where(and(
    eq(officialAppAutoInstallStates.serverId, target.id),
    eq(officialAppAutoInstallStates.clientId, client.id),
  ));
  assert.equal(suppressed?.state, "auto_suppressed");

  const reinstall = await fetch(`${app.baseUrl}/api/integrations/marketplace/${client.id}/install`, {
    method: "POST",
    headers: humanHeaders(token, target.id),
  });
  assert.equal(reinstall.status, 200);
  const [restored] = await getDb().select().from(officialAppAutoInstallStates).where(and(
    eq(officialAppAutoInstallStates.serverId, target.id),
    eq(officialAppAutoInstallStates.clientId, client.id),
  ));
  assert.equal(restored?.state, "default_auto");
  const sources = (await getDb().select({ source: officialAppAutoInstallTransitions.transitionSource })
    .from(officialAppAutoInstallTransitions).where(and(
      eq(officialAppAutoInstallTransitions.serverId, target.id),
      eq(officialAppAutoInstallTransitions.clientId, client.id),
    ))).map(({ source }) => source);
  assert.deepEqual(sources, ["auto_install", "user_uninstall", "user_install"]);

  const secondUninstall = await fetch(`${app.baseUrl}/api/integrations/marketplace/${client.id}/install`, {
    method: "DELETE",
    headers: humanHeaders(token, target.id),
  });
  assert.equal(secondUninstall.status, 200);
  const [suppressedAgain] = await getDb().select().from(officialAppAutoInstallStates).where(and(
    eq(officialAppAutoInstallStates.serverId, target.id),
    eq(officialAppAutoInstallStates.clientId, client.id),
  ));
  assert.equal(suppressedAgain?.state, "auto_suppressed");
});

test("migration reconciliation suppresses unknown absent rows and never resurrects them", async ({ app: _app }) => {
  const owner = await seedUser("official-migration");
  const source = await createServer("Botiverse", `botiverse-${randomUUID()}`, owner.id);
  const target = await createServer("Historical Target", `historical-${randomUUID()}`, owner.id);
  const client = await seedPublishedApp({ sourceServerId: source.id, createdByUserId: owner.id });
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = source.id;
  await seedRegistry(client);

  await reconcileOfficialDefaultAppForExistingServers({ clientKey: client.clientId, unknownState: "suppress_unknown" });
  const [state] = await getDb().select().from(officialAppAutoInstallStates).where(and(
    eq(officialAppAutoInstallStates.serverId, target.id),
    eq(officialAppAutoInstallStates.clientId, client.id),
  ));
  assert.equal(state?.state, "auto_suppressed");
  assert.equal((await getDb().select().from(oauthClientInstalls).where(and(
    eq(oauthClientInstalls.serverId, target.id),
    eq(oauthClientInstalls.clientId, client.id),
  ))).length, 0);
});

test("agent lifecycle remains read-only and makes zero official install attempts", async ({ app: _app }) => {
  const owner = await seedUser("official-agent-event");
  const server = await createServer("Agent Event", `agent-event-${randomUUID()}`, owner.id);
  let attempts = 0;
  __setOfficialAppAutoInstallAttemptObserverForTests(() => attempts += 1);
  await createAgent(server.id, `agent-${randomUUID().slice(0, 8)}`);
  assert.equal(attempts, 0);
});

test("default reconciliation excludes exact internal Server kinds before any install attempt", async ({ app: _app }) => {
  const owner = await seedUser("official-internal-exclusion");
  const source = await createServer("Botiverse", `botiverse-${randomUUID()}`, owner.id);
  const internal = await createServer("Internal Storage", `internal-storage-${randomUUID()}`, owner.id);
  await getDb().update(servers).set({ kind: "joint_storage" }).where(eq(servers.id, internal.id));
  const client = await seedPublishedApp({ sourceServerId: source.id, createdByUserId: owner.id });
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = source.id;
  await seedRegistry(client);

  const attemptedServerIds: string[] = [];
  __setOfficialAppAutoInstallAttemptObserverForTests((serverId) => attemptedServerIds.push(serverId));
  await reconcileOfficialDefaultAppForExistingServers({ clientKey: client.clientId, unknownState: "default_auto" });

  assert.equal(attemptedServerIds.includes(internal.id), false);
  assert.equal((await getDb().select().from(oauthClientInstalls).where(and(
    eq(oauthClientInstalls.serverId, internal.id),
    eq(oauthClientInstalls.clientId, client.id),
  ))).length, 0);
});

test("concurrent auto-install and explicit uninstall serialize to suppression with no half-install", async ({ app }) => {
  const owner = await seedUser("official-race");
  const token = await tokenForHuman(owner.email);
  const source = await createServer("Botiverse", `botiverse-${randomUUID()}`, owner.id);
  const client = await seedPublishedApp({ sourceServerId: source.id, createdByUserId: owner.id });
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = source.id;
  await seedRegistry(client);
  const target = await createServer("Race Target", `race-target-${randomUUID()}`, owner.id);

  // Preserve default-auto state while making the installation absent, so the
  // automatic path reaches its write point and races the explicit opt-out.
  await getDb().delete(oauthClientInstalls).where(and(
    eq(oauthClientInstalls.serverId, target.id),
    eq(oauthClientInstalls.clientId, client.id),
  ));
  let releaseWrite!: () => void;
  let announceWrite!: () => void;
  const atWrite = new Promise<void>((resolve) => { announceWrite = resolve; });
  const release = new Promise<void>((resolve) => { releaseWrite = resolve; });
  __setBeforeOfficialAppAutoInstallWriteObserverForTests(async (serverId) => {
    if (serverId !== target.id) return;
    announceWrite();
    await release;
  });

  const automatic = reconcileOfficialDefaultAppForExistingServers({
    clientKey: client.clientId,
    unknownState: "default_auto",
  });
  await atWrite;
  const explicitUninstall = fetch(`${app.baseUrl}/api/integrations/marketplace/${client.id}/install`, {
    method: "DELETE",
    headers: humanHeaders(token, target.id),
  });
  releaseWrite();
  const [, uninstallResponse] = await Promise.all([automatic, explicitUninstall]);
  assert.equal(uninstallResponse.status, 200);

  const [state] = await getDb().select().from(officialAppAutoInstallStates).where(and(
    eq(officialAppAutoInstallStates.serverId, target.id),
    eq(officialAppAutoInstallStates.clientId, client.id),
  ));
  assert.equal(state?.state, "auto_suppressed");
  assert.equal((await getDb().select().from(oauthClientInstalls).where(and(
    eq(oauthClientInstalls.serverId, target.id),
    eq(oauthClientInstalls.clientId, client.id),
  ))).length, 0);
});
