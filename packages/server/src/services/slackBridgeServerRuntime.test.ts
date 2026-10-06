import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import {
  agents,
  channelAgents,
  channelHumans,
  channels,
  externalActorProjections,
  externalAddressabilityProjections,
  externalAppCredentials,
  externalAppInstallServerGrants,
  externalAppInstalls,
  externalAppRegistrations,
  externalAppRegistrationSecrets,
  externalAppServerGrants,
  externalBindingAudienceSnapshots,
  externalChannelBindings,
  externalHumanIdentityLinks,
  externalInboundEvents,
  externalMessageLinks,
  externalOutboundDeliveries,
  featureFlags,
  messages,
  oauthClientInstalls,
  oauthClients,
  servers,
  users,
} from "../db/schema";
import { SLACK_BRIDGE_REQUIRED_BOT_SCOPES } from "../routes/slackBridge";
import { resolveExternalBindingAuthority } from "./externalAppControlPlaneService";
import {
  createFeatureFlagRule,
  updateFeatureFlagRule,
} from "./featureFlagService";
import {
  enqueueExternalInboundEvent,
  type ExternalInboundNormalizedMessage,
  type ExternalInboundRuntimeAuthority,
} from "./externalInboundWorkerService";
import { createServer } from "./serverService";
import { broadcastAndDeliver } from "./messageService";
import {
  EXTERNAL_DELIVERY_AUTHORITY_BACKOFF_BASE_MS,
  EXTERNAL_DELIVERY_AUTHORITY_OVERDUE_MS,
  type ExternalDeliveryAuthorityAlert,
} from "./externalDeliveryWorkerService";
import { slackBridgeDatabaseRuntimeRevision } from "./slackBridgeDatabaseRuntimeAuthority";
import {
  createSlackBridgeEnvCredentialCipher,
  slackBridgeKeyFromEnv,
  SLACK_BRIDGE_CREDENTIAL_KEY_ID,
} from "./slackBridgeEnvSecrets";
import { createSlackBridgeServerRuntimeFromEnv } from "./slackBridgeServerRuntime";


const MANAGED_ENV: NodeJS.ProcessEnv = {
  SLACK_BRIDGE_ENVIRONMENT: "production",
  SLACK_BRIDGE_REGISTRATION_ID: "11111111-1111-4111-8111-111111111111",
  SLACK_BRIDGE_PROVIDER_APP_ID: "A_MANAGED_RUNTIME",
  SLACK_BRIDGE_PROVIDER_OAUTH_CLIENT_ID: "managed-runtime-client",
  SLACK_BRIDGE_OAUTH_REDIRECT_URI: "https://raft.example/api/slack-bridge/oauth/callback",
  SLACK_BRIDGE_EVENTS_REQUEST_URL: "https://bridge.example/api/slack-bridge/events",
  SLACK_BRIDGE_SIGNING_SECRET: "signing-secret",
  SLACK_BRIDGE_OAUTH_CLIENT_SECRET: "oauth-client-secret",
  SLACK_BRIDGE_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  SLACK_BRIDGE_PAYLOAD_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  APP_URL: "https://raft.example/",
};

const NOW = new Date("2026-08-11T20:00:00.000Z");

const noopOrchestrator = { deliverMessage: async () => undefined } as any;

function createIo() {
  return {
    to() {
      return { emit() {} };
    },
    in() {
      return { in() { return { socketsJoin() {} }; }, socketsJoin() {} };
    },
  } as any;
}

beforeEach(async () => {
  await openTestDatabase("pglite://");
});

afterEach(async () => {
  await closeTestDatabase();
});

async function seedManagedAudience(privacyClass: "public" | "private" = "private") {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `slack-managed-${randomUUID()}@raft.test`,
    name: `slack-managed-${randomUUID().slice(0, 8)}`,
    passwordHash: "test-only",
    emailVerified: true,
  }).returning();
  const server = await createServer(
    "Slack Managed Runtime",
    `slack-managed-${randomUUID()}`,
    owner.id,
  );
  const masterRule = await createFeatureFlagRule({
    flagKey: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
    stage: "server",
    decision: "allow",
    values: [server.id],
  });
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: `slack-private-${randomUUID().slice(0, 8)}`,
    type: privacyClass === "private" ? "private" : "channel",
  }).returning();
  await db.insert(channelHumans).values({ channelId: channel.id, userId: owner.id });
  const [client] = await db.insert(oauthClients).values({
    serverId: server.id,
    clientId: `slack-managed-${randomUUID()}`,
    clientSecretHash: "test-only",
    appType: "slock_builtin",
    name: "Slack Bridge",
    allowedScopes: ["messages:read", "messages:write"],
    createdByUserId: owner.id,
  }).returning();
  await db.insert(oauthClientInstalls).values({
    serverId: server.id,
    clientId: client.id,
    installedByUserId: owner.id,
  });
  const [registration] = await db.insert(externalAppRegistrations).values({
    id: MANAGED_ENV.SLACK_BRIDGE_REGISTRATION_ID,
    oauthClientId: client.id,
    provider: "slack",
    environment: "production",
    providerAppId: "A_MANAGED_RUNTIME",
    providerOAuthClientId: "managed-runtime-client",
    capabilityManifestVersion: 1,
    capabilityManifestHash: "managed-runtime-v1",
    requiredCapabilities: ["private_audience"],
  }).returning();
  const [grant] = await db.insert(externalAppServerGrants).values({
    serverId: server.id,
    registrationId: registration.id,
    grantEpoch: 1,
    grantedManifestVersion: 1,
    grantedManifestHash: "managed-runtime-v1",
    grantedCapabilities: ["private_audience"],
    grantedByType: "human",
    grantedById: owner.id,
  }).returning();
  await db.insert(externalAppRegistrationSecrets).values({
    registrationId: registration.id,
    purpose: "signing_secret",
    encryptedSecretRef: "env://SLACK_BRIDGE_SIGNING_SECRET",
    envelopeKeyId: "env:process",
    secretRevision: 1,
  });
  const [install] = await db.insert(externalAppInstalls).values({
    serverId: server.id,
    registrationId: registration.id,
    serverGrantId: grant.id,
    grantEpoch: 1,
    state: "active",
    connectionEpoch: 2,
    scopeRevision: 1,
    credentialRevision: 1,
    installedScopes: [...SLACK_BRIDGE_REQUIRED_BOT_SCOPES],
    providerAppId: "A_MANAGED_RUNTIME",
    providerTeamId: "T_MANAGED_RUNTIME",
    authorityType: "team",
    providerAuthorityId: "T_MANAGED_RUNTIME",
    botUserId: "U_MANAGED_BOT",
  }).returning();
  await db.insert(externalAppInstallServerGrants).values({
    installId: install.id,
    serverId: server.id,
    registrationId: registration.id,
    serverGrantId: grant.id,
    grantEpoch: grant.grantEpoch,
    state: "active",
    authorizedByType: "human",
    authorizedById: owner.id,
  });
  const credentialCipher = createSlackBridgeEnvCredentialCipher({
    key: slackBridgeKeyFromEnv(
      MANAGED_ENV.SLACK_BRIDGE_CREDENTIAL_ENCRYPTION_KEY,
      "SLACK_BRIDGE_CREDENTIAL_ENCRYPTION_KEY",
    ),
  });
  const sealed = await credentialCipher.sealer.seal({
    serverId: server.id,
    accessToken: "xoxb-managed-test",
    tokenType: "bot",
    providerAppId: "A_MANAGED_RUNTIME",
    providerTeamId: "T_MANAGED_RUNTIME",
    botUserId: "U_MANAGED_BOT",
    now: NOW,
  });
  await db.insert(externalAppCredentials).values({
    installId: install.id,
    state: "active",
    encryptedMaterial: sealed.encryptedMaterial,
    envelopeKeyId: sealed.envelopeKeyId,
    aadVersion: sealed.aadVersion,
    credentialRevision: 1,
  });
  const [binding] = await db.insert(externalChannelBindings).values({
    serverId: server.id,
    registrationId: registration.id,
    installId: install.id,
    channelId: channel.id,
    providerConversationId: privacyClass === "private" ? "G_MANAGED_PRIVATE" : "C_MANAGED_PUBLIC",
    providerConversationKind: privacyClass === "private" ? "private_channel" : "public_channel",
    privacyClass,
    state: "active",
    grantEpoch: 1,
    connectionEpoch: 2,
    bindingEpoch: 3,
    audienceRevision: privacyClass === "private" ? 1 : null,
    audienceFreshUntil: privacyClass === "private" ? new Date(NOW.getTime() + 60_000) : null,
    consentedByType: "human",
    consentedById: owner.id,
    consentedAt: NOW,
  }).returning();
  await db.insert(externalBindingAudienceSnapshots).values({
    bindingId: binding.id,
    bindingEpoch: 3,
    audienceRevision: 1,
    externalMemberCount: 1,
    externalAudienceDigest: "old-external",
    raftMemberCount: 1,
    raftAudienceDigest: "old-raft",
    status: privacyClass === "private" ? "unavailable" : "matched",
    observedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000),
  });
  const [projection] = await db.insert(externalActorProjections).values({
    provider: "slack",
    appRegistrationId: registration.id,
    installId: install.id,
    workspaceId: "T_MANAGED_RUNTIME",
    externalActorId: "U_MANAGED_OWNER",
    displayName: "Managed Owner",
    handles: ["managed-owner"],
    actorKind: "human",
    state: "active",
    deactivated: false,
    projectionRevision: 1,
    observedAt: NOW,
  }).returning();
  await db.insert(externalHumanIdentityLinks).values({
    serverId: server.id,
    installId: install.id,
    userId: owner.id,
    provider: "slack",
    providerAuthorityId: "T_MANAGED_RUNTIME",
    providerUserId: "U_MANAGED_OWNER",
    state: "active",
    linkEpoch: 1,
    observedConnectionEpoch: 2,
  });
  await db.insert(externalAddressabilityProjections).values({
    projectionId: projection.id,
    provider: "slack",
    appRegistrationId: registration.id,
    installId: install.id,
    workspaceId: "T_MANAGED_RUNTIME",
    connectionEpoch: 2,
    bindingId: binding.id,
    bindingEpoch: 3,
    conversationId: "G_MANAGED_PRIVATE",
    memberRevision: 1,
    contextRevision: 1,
    state: "active",
    observedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60 * 60_000),
  });
  return {
    owner,
    server,
    channel,
    registration,
    grant,
    install,
    binding,
    projection,
    masterRule,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function waitFor(
  predicate: () => Promise<boolean>,
  label: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("managed runtime selection is explicit, complete, and mutually exclusive with local custody", async () => {
  assert.equal(await createSlackBridgeServerRuntimeFromEnv({ NODE_ENV: "production" }), undefined);
  await assert.rejects(createSlackBridgeServerRuntimeFromEnv({
    SLACK_BRIDGE_PAYLOAD_KMS_KEY_ID: "kms-key",
  }), /legacy local\/AWS runtime configuration is not supported/);
  await assert.rejects(createSlackBridgeServerRuntimeFromEnv({
    ...MANAGED_ENV,
    SLACK_BRIDGE_LOCAL_RUNTIME_CONFIG_FILE: "/tmp/local.json",
  }), /legacy local\/AWS runtime configuration is not supported/);
  await assert.rejects(createSlackBridgeServerRuntimeFromEnv({
    ...MANAGED_ENV,
    SLACK_BRIDGE_EVENTS_REQUEST_URL: "http://bridge.example/api/slack-bridge/events",
  }), /credential-free HTTPS/);
  await assert.rejects(createSlackBridgeServerRuntimeFromEnv({
    ...MANAGED_ENV,
    APP_URL: "http://raft.example",
  }), /app URL must be credential-free HTTPS/);
  const missingAppUrl = { ...MANAGED_ENV };
  delete missingAppUrl.APP_URL;
  await assert.rejects(
    createSlackBridgeServerRuntimeFromEnv(missingAppUrl),
    /requires APP_URL/,
  );
  const missing = { ...MANAGED_ENV };
  delete missing.SLACK_BRIDGE_PAYLOAD_ENCRYPTION_KEY;
  await assert.rejects(createSlackBridgeServerRuntimeFromEnv(missing), /SLACK_BRIDGE_PAYLOAD_ENCRYPTION_KEY/);
});

test("managed test runtime requires an explicit credential-free HTTP(S) app origin", async () => {
  const testEnv: NodeJS.ProcessEnv = {
    ...MANAGED_ENV,
    SLACK_BRIDGE_ENVIRONMENT: "test",
    APP_URL: "http://127.0.0.1:5173/ignored/path",
  };
  const runtime = await createSlackBridgeServerRuntimeFromEnv(testEnv);
  assert.ok(runtime);
  assert.equal(runtime.appOrigin, "http://127.0.0.1:5173");
  await runtime.stop();

  const missingAppUrl = { ...testEnv };
  delete missingAppUrl.APP_URL;
  await assert.rejects(
    createSlackBridgeServerRuntimeFromEnv(missingAppUrl),
    /requires APP_URL/,
  );
  await assert.rejects(
    createSlackBridgeServerRuntimeFromEnv({
      ...testEnv,
      APP_URL: "not a URL",
    }),
    /app URL is invalid/,
  );
  await assert.rejects(
    createSlackBridgeServerRuntimeFromEnv({
      ...testEnv,
      APP_URL: "https://user:password@raft.example",
    }),
    /app URL must be credential-free HTTP\(S\)/,
  );
  await assert.rejects(
    createSlackBridgeServerRuntimeFromEnv({
      ...testEnv,
      APP_URL: "ftp://raft.example",
    }),
    /app URL must be credential-free HTTP\(S\)/,
  );
});

test("managed runtime composition is side-effect free before the server start hook", async () => {
  let providerCalls = 0;
  const runtime = await createSlackBridgeServerRuntimeFromEnv(MANAGED_ENV, {
    fetch: (async () => {
      providerCalls += 1;
      throw new Error("must not call Slack during startup");
    }) as typeof fetch,
  });

  assert.ok(runtime && "inboundWorkerDependencies" in runtime);
  assert.equal(runtime.environment, "production");
  assert.equal(runtime.oauthRedirectUri, MANAGED_ENV.SLACK_BRIDGE_OAUTH_REDIRECT_URI);
  assert.equal(runtime.eventsRequestUrl, MANAGED_ENV.SLACK_BRIDGE_EVENTS_REQUEST_URL);
  assert.equal(typeof runtime.secretResolver.resolveSigningSecret, "function");
  assert.equal(typeof runtime.payloadSealer.sealNormalizedPayload, "function");
  assert.equal(typeof runtime.runtimeResolver?.resolveCurrentRuntime, "function");
  assert.equal(typeof runtime.provisioning?.load, "function");
  assert.equal(typeof runtime.inboundWorkerDependencies.decryptNormalizedPayload, "function");
  assert.equal(typeof runtime.inboundWorkerDependencies.resolveCurrentRuntime, "function");
  await runtime.stop();
  assert.equal(providerCalls, 0);
});

test("managed runtime resolves the trusted IM Bridges destination from the claimed server", async () => {
  const seeded = await seedManagedAudience();
  const runtime = await createSlackBridgeServerRuntimeFromEnv(MANAGED_ENV, {
    db: getDb(),
  });
  assert.ok(runtime);

  assert.equal(
    await runtime.resolveOAuthCompletionRedirectPath({ serverId: seeded.server.id }),
    `/s/${encodeURIComponent(seeded.server.slug)}/settings/im-bridges`,
  );
  assert.equal(
    await runtime.resolveOAuthCompletionRedirectPath({ serverId: randomUUID() }),
    null,
  );
  await getDb()
    .update(servers)
    .set({ kind: "joint_storage" })
    .where(eq(servers.id, seeded.server.id));
  assert.equal(
    await runtime.resolveOAuthCompletionRedirectPath({ serverId: seeded.server.id }),
    null,
  );
  await getDb()
    .update(servers)
    .set({ kind: "normal", deletedAt: NOW })
    .where(eq(servers.id, seeded.server.id));
  assert.equal(
    await runtime.resolveOAuthCompletionRedirectPath({ serverId: seeded.server.id }),
    null,
  );
  await runtime.stop();
});

test("attachment authority rejects a stale server-grant epoch with the canonical binding fence", async () => {
  const seeded = await seedManagedAudience("public");
  await getDb().insert(featureFlags).values({
    key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.attachmentTransfer,
    description: "Slack attachment transfer",
    enabled: true,
    defaultEnabled: false,
    killSwitch: false,
    randomizationUnit: "server",
    salt: SLACK_BRIDGE_FEATURE_FLAG_KEYS.attachmentTransfer,
  });
  await createFeatureFlagRule({
    flagKey: SLACK_BRIDGE_FEATURE_FLAG_KEYS.attachmentTransfer,
    stage: "server",
    decision: "allow",
    values: [seeded.server.id],
  });
  const runtime = await createSlackBridgeServerRuntimeFromEnv(MANAGED_ENV, {
    db: getDb(),
    now: () => NOW,
  });
  assert.ok(runtime);
  const authority = {
    provider: "slack",
    appRegistrationId: seeded.registration.id,
    installId: seeded.install.id,
    workspaceId: seeded.install.providerAuthorityId,
    providerAuthorityId: seeded.install.providerAuthorityId,
    providerConversationId: seeded.binding.providerConversationId,
    connectionEpoch: seeded.install.connectionEpoch,
    bindingId: seeded.binding.id,
    bindingEpoch: seeded.binding.bindingEpoch,
  };
  const authorityIsCurrent = runtime.inboundAttachmentWorkerDependencies.authorityIsCurrent;
  assert.ok(authorityIsCurrent);
  assert.equal(await authorityIsCurrent(authority, seeded.projection.id, getDb()), true);

  await getDb().update(externalAppServerGrants).set({ grantEpoch: 2 })
    .where(eq(externalAppServerGrants.id, seeded.grant.id));
  const canonical = await resolveExternalBindingAuthority({
    serverId: seeded.server.id,
    bindingId: seeded.binding.id,
    expectedConnectionEpoch: seeded.binding.connectionEpoch,
    expectedBindingEpoch: seeded.binding.bindingEpoch,
    now: NOW,
  });
  assert.deepEqual(canonical, { active: false, reason: "epoch_mismatch" });
  assert.equal(await authorityIsCurrent(authority, seeded.projection.id, getDb()), false);
  await runtime.stop();
});

test("managed server lifecycle consumes the database human resolver on start, event, periodic, and stop", async () => {
  const seeded = await seedManagedAudience();
  let installGrantCalls = 0;
  let audienceCalls = 0;
  let privacyCalls = 0;
  let rateLimitNextPrivacyCall = false;
  let runtimeNow = NOW;
  let periodic: () => void = () => assert.fail("periodic callback was not scheduled");
  let cleared = false;
  const receipts: unknown[] = [];
  let receiptWaiter: (() => void) | null = null;
  const waitForReceipt = async (count: number) => {
    while (receipts.length < count) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`missing lifecycle receipt ${count}`)),
          1_000,
        );
        receiptWaiter = () => {
          clearTimeout(timeout);
          resolve();
        };
      });
    }
  };
  const runtime = await createSlackBridgeServerRuntimeFromEnv(MANAGED_ENV, {
    db: getDb(),
    now: () => runtimeNow,
    lifecycleIntervalMs: 1_000,
    lifecycleClock: {
      scheduleEvery(fn, intervalMs) {
        assert.equal(intervalMs, 1_000);
        periodic = fn;
        return "managed-lifecycle";
      },
      clear(handle) {
        assert.equal(handle, "managed-lifecycle");
        cleared = true;
      },
    },
    onLifecycleReceipt(receipt) {
      receipts.push(receipt);
      receiptWaiter?.();
      receiptWaiter = null;
    },
    fetch: (async (url, init) => {
      assert.match(String(new Headers(init?.headers).get("authorization")), /^Bearer xoxb-/);
      if (String(url) === "https://slack.com/api/auth.test") {
        installGrantCalls += 1;
        return new Response(JSON.stringify({
          ok: true,
          app_id: "A_MANAGED_RUNTIME",
          team_id: "T_MANAGED_RUNTIME",
          user_id: "U_MANAGED_BOT",
          bot_id: "B_MANAGED_BOT",
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-oauth-scopes": SLACK_BRIDGE_REQUIRED_BOT_SCOPES.join(","),
          },
        });
      }
      if (String(url).startsWith("https://slack.com/api/conversations.info")) {
        privacyCalls += 1;
        const requestUrl = new URL(String(url));
        const providerConversationId = requestUrl.searchParams.get("channel");
        assert.ok([
          "G_MANAGED_PRIVATE",
          "G_MANAGED_PRIVATE_SECOND",
        ].includes(providerConversationId ?? ""));
        if (rateLimitNextPrivacyCall) {
          rateLimitNextPrivacyCall = false;
          return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "120" },
          });
        }
        return new Response(JSON.stringify({
          ok: true,
          channel: {
            id: providerConversationId,
            is_private: true,
            is_archived: false,
            is_member: true,
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      audienceCalls += 1;
      const requestUrl = new URL(String(url));
      assert.equal(
        requestUrl.origin + requestUrl.pathname,
        "https://slack.com/api/conversations.members",
      );
      assert.ok([
        "G_MANAGED_PRIVATE",
        "G_MANAGED_PRIVATE_SECOND",
      ].includes(requestUrl.searchParams.get("channel") ?? ""));
      assert.equal(requestUrl.searchParams.get("limit"), "200");
      assert.equal(requestUrl.searchParams.has("token"), false);
      assert.equal(init?.method, "GET");
      assert.equal(init?.body, undefined);
      assert.equal(new Headers(init?.headers).has("content-type"), false);
      return new Response(JSON.stringify({
        ok: true,
        members: ["U_MANAGED_OWNER", "U_MANAGED_BOT"],
        response_metadata: { next_cursor: "" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  assert.ok(runtime && "requestLifecycleReconcile" in runtime);

  runtime.start();
  await waitForReceipt(1);
  assert.equal(installGrantCalls, 1, "server start repairs missing install authority once");
  assert.equal(audienceCalls, 1, "server start performs one live audience refresh");
  assert.equal(privacyCalls, 1, "server start verifies provider privacy separately");
  const startSnapshot = await getDb().select().from(externalBindingAudienceSnapshots);
  assert.equal(startSnapshot.at(-1)?.bindingId, seeded.binding.id);
  assert.equal(startSnapshot.at(-1)?.status, "matched");

  await runtime.requestLifecycleReconcile?.();
  await waitForReceipt(2);
  assert.equal(installGrantCalls, 1, "fresh install authority is not re-read on every event");
  assert.equal(audienceCalls, 2, "post-ingress event reconciliation reaches the provider");
  assert.equal(privacyCalls, 2, "post-ingress event refreshes privacy freshness");

  periodic();
  await waitForReceipt(3);
  assert.equal(installGrantCalls, 1, "fresh install authority is not re-read on every tick");
  assert.equal(audienceCalls, 3, "persistent periodic reconciliation reaches the provider");
  assert.equal(privacyCalls, 3, "periodic reconciliation refreshes privacy freshness");

  const [secondChannel] = await getDb().insert(channels).values({
    serverId: seeded.server.id,
    name: `slack-private-second-${randomUUID().slice(0, 8)}`,
    type: "private",
  }).returning();
  await getDb().insert(channelHumans).values({
    channelId: secondChannel.id,
    userId: seeded.owner.id,
  });
  const [secondBinding] = await getDb().insert(externalChannelBindings).values({
    id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    serverId: seeded.server.id,
    registrationId: seeded.registration.id,
    installId: seeded.install.id,
    channelId: secondChannel.id,
    providerConversationId: "G_MANAGED_PRIVATE_SECOND",
    providerConversationKind: "private_channel",
    privacyClass: "private",
    state: "active",
    grantEpoch: 1,
    connectionEpoch: 2,
    bindingEpoch: 1,
    audienceRevision: 1,
    audienceFreshUntil: new Date(NOW.getTime() + 60_000),
    consentedByType: "human",
    consentedById: seeded.owner.id,
    consentedAt: NOW,
  }).returning();
  rateLimitNextPrivacyCall = true;
  await runtime.requestLifecycleReconcile?.();
  await waitForReceipt(4);
  assert.equal(
    privacyCalls,
    4,
    "the first binding rate limit stops the same install before its second provider call",
  );
  await runtime.requestLifecycleReconcile?.();
  await waitForReceipt(5);
  assert.equal(
    privacyCalls,
    4,
    "event reconciliation must not retry privacy before Slack Retry-After",
  );
  runtimeNow = new Date(NOW.getTime() + 120_000);
  await runtime.requestLifecycleReconcile?.();
  await waitForReceipt(6);
  assert.equal(
    privacyCalls,
    6,
    "both bindings resume only after their shared install retry deadline",
  );
  await getDb().update(externalChannelBindings).set({
    state: "paused",
    stateReason: "test_second_binding_pause",
  }).where(eq(externalChannelBindings.id, secondBinding.id));
  const audienceCallsAfterPrivacyBackoff = audienceCalls;

  await getDb().update(externalAppCredentials).set({ envelopeKeyId: "env:wrong-key" });
  await runtime.requestLifecycleReconcile?.();
  await waitForReceipt(7);
  assert.equal(
    audienceCalls,
    audienceCallsAfterPrivacyBackoff,
    "a mismatched env key id fails closed before Slack access",
  );

  await getDb().update(externalAppCredentials).set({ envelopeKeyId: SLACK_BRIDGE_CREDENTIAL_KEY_ID });
  await getDb().delete(externalHumanIdentityLinks);
  await runtime.requestLifecycleReconcile?.();
  await waitForReceipt(8);
  assert.equal(
    audienceCalls,
    audienceCallsAfterPrivacyBackoff,
    "removing the task #8 human link fails closed before Slack provider access",
  );
  const unavailableSnapshot = await getDb().select().from(externalBindingAudienceSnapshots);
  assert.equal(unavailableSnapshot.at(-1)?.status, "unavailable");

  await getDb().update(externalChannelBindings).set({
    state: "paused",
    stateReason: "test_pause",
  });
  const pausedResult = await runtime.requestLifecycleReconcile?.();
  assert.deepEqual(pausedResult, { kind: "completed", trigger: "event", bindingCount: 0 });
  assert.equal(audienceCalls, audienceCallsAfterPrivacyBackoff);
  assert.equal(
    (await getDb().select().from(externalBindingAudienceSnapshots)).length,
    unavailableSnapshot.length,
    "inactive bindings do not append audience snapshots",
  );

  await runtime.stop();
  assert.equal(cleared, true);
  await runtime.requestLifecycleReconcile?.();
  assert.equal(
    audienceCalls,
    audienceCallsAfterPrivacyBackoff,
    "stopped runtime rejects later event reconciliation",
  );
});

test("managed server start and stop own the durable inbound worker lifecycle", async ({ onTestFinished }) => {
  const seeded = await seedManagedAudience();
  let firstReceipt: (() => void) | null = null;
  const started = new Promise<void>((resolve) => {
    firstReceipt = resolve;
  });
  const runtime = await createSlackBridgeServerRuntimeFromEnv(MANAGED_ENV, {
    db: getDb(),
    now: () => NOW,
    lifecycleIntervalMs: 60_000,
    inboundWorkerIntervalMs: 10,
    inboundWorkerLeaseOwner: "managed-runtime-inbound-test",
    onLifecycleReceipt() {
      firstReceipt?.();
      firstReceipt = null;
    },
    fetch: (async (url) => {
      if (String(url) === "https://slack.com/api/auth.test") {
        return new Response(JSON.stringify({
          ok: true,
          app_id: "A_MANAGED_RUNTIME",
          team_id: "T_MANAGED_RUNTIME",
          user_id: "U_MANAGED_BOT",
          bot_id: "B_MANAGED_BOT",
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-oauth-scopes": SLACK_BRIDGE_REQUIRED_BOT_SCOPES.join(","),
          },
        });
      }
      return new Response(JSON.stringify({
        ok: true,
        members: ["U_MANAGED_OWNER", "U_MANAGED_BOT"],
        response_metadata: { next_cursor: "" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  assert.ok(runtime);
  onTestFinished(async () => runtime.stop());

  runtime.start();
  await started;
  const authorityDecision = await resolveExternalBindingAuthority({
    serverId: seeded.server.id,
    bindingId: seeded.binding.id,
    expectedConnectionEpoch: seeded.install.connectionEpoch,
    expectedBindingEpoch: seeded.binding.bindingEpoch,
    now: NOW,
  }, getDb());
  if (!authorityDecision.active) assert.fail(authorityDecision.reason);
  const authority: ExternalInboundRuntimeAuthority = {
    runtimeRevision: slackBridgeDatabaseRuntimeRevision(authorityDecision.fact),
    provider: authorityDecision.fact.provider,
    environment: authorityDecision.fact.environment,
    appRegistrationId: authorityDecision.fact.registrationId,
    installId: authorityDecision.fact.installId,
    workspaceId: authorityDecision.fact.providerAuthorityId,
    providerAuthorityId: authorityDecision.fact.providerAuthorityId,
    providerConversationId: authorityDecision.fact.providerConversationId,
    bindingId: authorityDecision.fact.bindingId,
    bindingEpoch: authorityDecision.fact.bindingEpoch,
    connectionEpoch: authorityDecision.fact.connectionEpoch,
    raftChannelId: authorityDecision.fact.channelId,
    privacyClass: authorityDecision.fact.privacyClass,
  };
  const admit = async (providerEventId: string, providerMessageId: string) => {
    const payload: ExternalInboundNormalizedMessage = {
      schema: "external-inbound-normalized-event.v1",
      projectionId: seeded.projection.id,
      actorProjectionRevision: seeded.projection.projectionRevision,
      externalActorId: seeded.projection.externalActorId,
      providerMessageId,
      providerThreadId: null,
      content: `managed runtime inbound ${providerMessageId}`,
      createdAt: NOW.toISOString(),
    };
    const plaintext = JSON.stringify(payload);
    const aad = {
      purpose: "external-inbound-normalized-event" as const,
      aadVersion: 1 as const,
      schemaVersion: 1 as const,
      provider: "slack" as const,
      environment: authority.environment,
      appRegistrationId: authority.appRegistrationId,
      installId: authority.installId,
      workspaceId: authority.workspaceId,
      providerAuthorityId: authority.providerAuthorityId,
      providerConversationId: authority.providerConversationId,
      providerEventId,
      bindingId: authority.bindingId,
      bindingEpoch: authority.bindingEpoch,
      connectionEpoch: authority.connectionEpoch,
      runtimeRevision: authority.runtimeRevision,
      raftChannelId: authority.raftChannelId,
      privacyClass: authority.privacyClass,
    };
    const sealed = await runtime.payloadSealer.sealNormalizedPayload({ plaintext, aad });
    return {
      sealed,
      enqueue: () => enqueueExternalInboundEvent({
        db: getDb(),
        authority,
        providerEventId,
        normalizedPayloadDigest: sha256(plaintext),
        encryptedPayload: sealed.encryptedPayload,
        envelopeKeyId: sealed.envelopeKeyId,
        payloadExpiresAt: new Date(NOW.getTime() + 5 * 60_000),
        receivedAt: NOW,
      }),
    };
  };

  const beforeStart = {
    messages: (await getDb().select().from(messages)).length,
    links: (await getDb().select().from(externalMessageLinks)).length,
  };
  const first = await admit("Ev-managed-start", "1786406400.000001");
  const firstEvent = await first.enqueue();
  await waitFor(async () => {
    const event = (await getDb().select().from(externalInboundEvents))
      .find((row) => row.id === firstEvent.event.id);
    return event?.status === "committed" || Boolean(event?.outcomeReason);
  }, "managed inbound worker outcome after runtime start");
  const committedEvent = (await getDb().select().from(externalInboundEvents))
    .find((row) => row.id === firstEvent.event.id);
  assert.equal(
    committedEvent?.status,
    "committed",
    `managed inbound worker outcome: ${committedEvent?.outcomeReason ?? "missing"}`,
  );
  assert.equal((await getDb().select().from(messages)).length, beforeStart.messages + 1);
  assert.equal((await getDb().select().from(externalMessageLinks)).length, beforeStart.links + 1);

  const afterStop = await admit("Ev-managed-stop", "1786406401.000001");
  await runtime.stop();
  const stoppedEvent = await afterStop.enqueue();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const [stoppedRow] = (await getDb().select().from(externalInboundEvents))
    .filter((row) => row.id === stoppedEvent.event.id);
  assert.equal(stoppedRow?.status, "queued", "runtime stop prevents later inbound consumption");
  assert.equal((await getDb().select().from(messages)).length, beforeStart.messages + 1);
  assert.equal((await getDb().select().from(externalMessageLinks)).length, beforeStart.links + 1);
});

test("managed server start owns ordinary Raft to Slack admission and delivery", async ({ onTestFinished }) => {
  const seeded = await seedManagedAudience();
  let workerNow = NOW;
  let firstReceipt: (() => void) | null = null;
  const started = new Promise<void>((resolve) => {
    firstReceipt = resolve;
  });
  const postedBodies: unknown[] = [];
  const authorityAlerts: ExternalDeliveryAuthorityAlert[] = [];
  const outboundErrors: unknown[] = [];
  const runtime = await createSlackBridgeServerRuntimeFromEnv(MANAGED_ENV, {
    db: getDb(),
    now: () => workerNow,
    lifecycleIntervalMs: 60_000,
    inboundWorkerIntervalMs: 60_000,
    outboundWorkerIntervalMs: 250,
    outboundWorkerLeaseOwner: "managed-runtime-outbound-test",
    onLifecycleReceipt() {
      firstReceipt?.();
      firstReceipt = null;
    },
    onOutboundAuthorityAlert(alert: ExternalDeliveryAuthorityAlert) {
      authorityAlerts.push(alert);
    },
    onOutboundError(error: unknown) {
      outboundErrors.push(error);
    },
    fetch: (async (url, init) => {
      const method = new URL(String(url)).pathname.split("/").at(-1);
      if (method === "auth.test") {
        return new Response(JSON.stringify({
          ok: true,
          team_id: "T_MANAGED_RUNTIME",
          user_id: "U_MANAGED_BOT",
          bot_id: "B_MANAGED_BOT",
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-oauth-scopes": SLACK_BRIDGE_REQUIRED_BOT_SCOPES.join(","),
          },
        });
      }
      if (method === "conversations.members") {
        return new Response(JSON.stringify({
          ok: true,
          members: ["U_MANAGED_OWNER", "U_MANAGED_BOT"],
          response_metadata: { next_cursor: "" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "chat.postMessage") {
        postedBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({
          ok: true,
          channel: "G_MANAGED_PRIVATE",
          ts: "1786601594.810619",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected Slack method ${method}`);
    }) as typeof fetch,
  } as any);
  assert.ok(runtime);
  onTestFinished(async () => runtime.stop());

  runtime.start();
  await started;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(
    outboundErrors,
    [],
    "an active legacy binding with no delivery partition is idle before its first message",
  );
  const [agent] = await getDb().insert(agents).values({
    serverId: seeded.server.id,
    name: "managed-runtime-agent",
    displayName: "Managed Runtime Agent",
    runtime: "codex",
  }).returning();
  await getDb().insert(channelAgents).values({ channelId: seeded.channel.id, agentId: agent.id });

  const message = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: seeded.channel.id,
    senderType: "agent",
    senderId: agent.id,
    senderName: agent.displayName!,
    content: "managed runtime outbound",
  });
  assert.equal(
    (await getDb().select().from(externalOutboundDeliveries)).length,
    1,
    "managed start must install outbound admission before the source transaction",
  );
  const staleSince = new Date(NOW.getTime() - EXTERNAL_DELIVERY_AUTHORITY_OVERDUE_MS);
  await getDb().update(externalOutboundDeliveries).set({
    createdAt: staleSince,
    updatedAt: staleSince,
  });
  await getDb().update(externalBindingAudienceSnapshots).set({ status: "mismatch" });
  await waitFor(async () => authorityAlerts.length === 1, "managed outbound overdue authority alert");
  assert.equal(
    postedBodies.length,
    0,
    "a private audience mismatch after enqueue must fail closed before Slack I/O",
  );
  assert.notEqual(
    (await getDb().select().from(externalOutboundDeliveries))[0]?.state,
    "accepted",
  );
  assert.deepEqual(authorityAlerts[0], {
    schema: "external-delivery-authority-alert.v1",
    severity: "overdue",
    deliveryId: (await getDb().select().from(externalOutboundDeliveries))[0]!.id,
    bindingId: seeded.binding.id,
    bindingEpoch: seeded.binding.bindingEpoch,
    partitionPosition: 1,
    blockReason: "runtime_authority_inactive_or_mismatched",
    observedAt: NOW.toISOString(),
    deliveryAgeMs: EXTERNAL_DELIVERY_AUTHORITY_OVERDUE_MS,
    requiredAction: "restore_authority_or_audited_skip",
  });

  await getDb().update(externalBindingAudienceSnapshots).set({ status: "matched" });
  workerNow = new Date(NOW.getTime() + EXTERNAL_DELIVERY_AUTHORITY_BACKOFF_BASE_MS);
  await waitFor(async () => {
    const [delivery] = await getDb().select().from(externalOutboundDeliveries);
    return delivery?.state === "accepted";
  }, "managed outbound acceptance");

  const [delivery] = await getDb().select().from(externalOutboundDeliveries);
  assert.equal(delivery?.sourceMessageId, message.id);
  assert.equal(delivery?.state, "accepted");
  assert.equal(postedBodies.length, 1);
  assert.equal((postedBodies[0] as { channel?: string }).channel, "G_MANAGED_PRIVATE");
  assert.match(
    String((postedBodies[0] as { text?: string }).text),
    /managed runtime outbound/,
  );

  await runtime.stop();
  await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: seeded.channel.id,
    senderType: "user",
    senderId: seeded.owner.id,
    senderName: seeded.owner.name,
    content: "managed runtime after stop",
  });
  assert.equal(
    (await getDb().select().from(externalOutboundDeliveries)).length,
    1,
    "runtime stop must uninstall ordinary outbound admission",
  );
  assert.equal(postedBodies.length, 1);
});

test("zero-policy public thread reply follows the exact accepted root link", async ({ onTestFinished }) => {
  const seeded = await seedManagedAudience("public");
  let firstReceipt: (() => void) | null = null;
  const started = new Promise<void>((resolve) => {
    firstReceipt = resolve;
  });
  const postedBodies: unknown[] = [];
  const runtime = await createSlackBridgeServerRuntimeFromEnv(MANAGED_ENV, {
    db: getDb(),
    now: () => NOW,
    lifecycleIntervalMs: 60_000,
    inboundWorkerIntervalMs: 60_000,
    outboundWorkerIntervalMs: 10,
    outboundWorkerLeaseOwner: "managed-runtime-public-thread-test",
    onLifecycleReceipt() {
      firstReceipt?.();
      firstReceipt = null;
    },
    fetch: (async (url, init) => {
      const method = new URL(String(url)).pathname.split("/").at(-1);
      if (method === "auth.test") {
        return new Response(JSON.stringify({
          ok: true,
          team_id: "T_MANAGED_RUNTIME",
          user_id: "U_MANAGED_BOT",
          bot_id: "B_MANAGED_BOT",
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-oauth-scopes": SLACK_BRIDGE_REQUIRED_BOT_SCOPES.join(","),
          },
        });
      }
      if (method === "conversations.members") {
        return new Response(JSON.stringify({
          ok: true,
          members: ["U_MANAGED_OWNER", "U_MANAGED_BOT"],
          response_metadata: { next_cursor: "" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "conversations.info") {
        return new Response(JSON.stringify({
          ok: true,
          channel: { id: "C_MANAGED_PUBLIC", is_channel: true, is_private: false },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "chat.postMessage") {
        postedBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({
          ok: true,
          channel: "C_MANAGED_PUBLIC",
          ts: "1786601594.810621",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected Slack method ${method}`);
    }) as typeof fetch,
  });
  assert.ok(runtime);
  onTestFinished(async () => runtime.stop());

  runtime.start();
  await started;
  await getDb().delete(externalBindingAudienceSnapshots)
    .where(eq(externalBindingAudienceSnapshots.bindingId, seeded.binding.id));
  await getDb().insert(externalBindingAudienceSnapshots).values({
    bindingId: seeded.binding.id,
    bindingEpoch: seeded.binding.bindingEpoch,
    audienceRevision: 1,
    externalMemberCount: 1,
    externalAudienceDigest: "public-thread-audience",
    raftMemberCount: 1,
    raftAudienceDigest: "public-thread-audience",
    status: "matched",
    observedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000),
  });
  const [agent] = await getDb().insert(agents).values({
    serverId: seeded.server.id,
    name: "managed-public-thread-agent",
    displayName: "Managed Public Thread Agent",
    runtime: "codex",
  }).returning();
  const [root] = await getDb().insert(messages).values({
    channelId: seeded.channel.id,
    senderType: "user",
    senderId: seeded.owner.id,
    content: "managed public root",
  }).returning();
  const [thread] = await getDb().insert(channels).values({
    serverId: seeded.server.id,
    name: `managed-public-thread-${randomUUID().slice(0, 8)}`,
    type: "thread",
    parentMessageId: root.id,
  }).returning();
  await getDb().update(messages).set({ threadId: thread.id }).where(eq(messages.id, root.id));
  await getDb().insert(channelAgents).values({ channelId: seeded.channel.id, agentId: agent.id });
  assert.equal(
    (await getDb().select().from(channelAgents).where(eq(channelAgents.channelId, thread.id))).length,
    0,
    "thread authority inherits the parent channel and has no legacy thread membership row",
  );
  await getDb().insert(externalMessageLinks).values({
    provider: "slack",
    installId: seeded.install.id,
    providerAuthorityId: seeded.install.providerAuthorityId,
    providerConversationId: seeded.binding.providerConversationId,
    providerMessageId: "1786601594.810600",
    bindingId: seeded.binding.id,
    bindingEpoch: seeded.binding.bindingEpoch,
    connectionEpoch: seeded.binding.connectionEpoch,
    raftMessageId: root.id,
    firstDirection: "raft_outbound",
    payloadFingerprint: "a".repeat(64),
    outcomeState: "accepted",
    authorityState: "active",
  });
  const reply = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: thread.id,
    senderType: "agent",
    senderId: agent.id,
    senderName: agent.displayName!,
    content: "managed public thread reply",
  });
  const [queued] = await getDb().select().from(externalOutboundDeliveries);
  assert.equal(queued?.sourceMessageId, reply.id);
  assert.equal(queued?.renderSnapshot.level, "thread");
  assert.equal(queued?.renderSnapshot.canonicalRootMessageId, root.id);
  await waitFor(async () => {
    const [delivery] = await getDb().select().from(externalOutboundDeliveries);
    return delivery?.state === "accepted";
  }, "managed public thread acceptance");
  assert.equal(postedBodies.length, 1);
  assert.equal((postedBodies[0] as { channel?: string }).channel, "C_MANAGED_PUBLIC");
  assert.equal((postedBodies[0] as { thread_ts?: string }).thread_ts, "1786601594.810600");
  assert.match(String((postedBodies[0] as { text?: string }).text), /managed public thread reply/);
});

test("managed active binding drops OFF-window Raft messages without replay after master recovery", async ({ onTestFinished }) => {
  const seeded = await seedManagedAudience();
  let firstReceipt: (() => void) | null = null;
  const started = new Promise<void>((resolve) => {
    firstReceipt = resolve;
  });
  const postedBodies: unknown[] = [];
  const runtime = await createSlackBridgeServerRuntimeFromEnv(MANAGED_ENV, {
    db: getDb(),
    now: () => NOW,
    lifecycleIntervalMs: 60_000,
    inboundWorkerIntervalMs: 60_000,
    outboundWorkerIntervalMs: 10,
    outboundWorkerLeaseOwner: "managed-runtime-master-gate-test",
    onLifecycleReceipt() {
      firstReceipt?.();
      firstReceipt = null;
    },
    fetch: (async (url, init) => {
      const method = new URL(String(url)).pathname.split("/").at(-1);
      if (method === "auth.test") {
        return new Response(JSON.stringify({
          ok: true,
          team_id: "T_MANAGED_RUNTIME",
          user_id: "U_MANAGED_BOT",
          bot_id: "B_MANAGED_BOT",
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-oauth-scopes": SLACK_BRIDGE_REQUIRED_BOT_SCOPES.join(","),
          },
        });
      }
      if (method === "conversations.members") {
        return new Response(JSON.stringify({
          ok: true,
          members: ["U_MANAGED_OWNER", "U_MANAGED_BOT"],
          response_metadata: { next_cursor: "" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "chat.postMessage") {
        postedBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({
          ok: true,
          channel: "G_MANAGED_PRIVATE",
          ts: "1786601594.810620",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected Slack method ${method}`);
    }) as typeof fetch,
  });
  assert.ok(runtime);
  onTestFinished(async () => runtime.stop());

  runtime.start();
  await started;
  await updateFeatureFlagRule(
    SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
    seeded.masterRule.id,
    { decision: "deny" },
  );
  const offMessage = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: seeded.channel.id,
    senderType: "user",
    senderId: seeded.owner.id,
    senderName: seeded.owner.name,
    content: "managed runtime master OFF",
  });
  assert.equal((await getDb().select().from(externalOutboundDeliveries)).length, 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(postedBodies.length, 0, "master OFF must stop Slack provider I/O");

  await updateFeatureFlagRule(
    SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
    seeded.masterRule.id,
    { decision: "allow" },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    (await getDb().select().from(externalOutboundDeliveries)).length,
    0,
    "master recovery must not enqueue the OFF-window message",
  );
  assert.equal(postedBodies.length, 0, "master recovery must not replay provider I/O");

  const onMessage = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: seeded.channel.id,
    senderType: "user",
    senderId: seeded.owner.id,
    senderName: seeded.owner.name,
    content: "managed runtime master recovered",
  });
  await waitFor(async () => {
    const deliveries = await getDb().select().from(externalOutboundDeliveries);
    return deliveries.length === 1 && deliveries[0]?.state === "accepted";
  }, "post-recovery managed outbound acceptance");

  const [delivery] = await getDb().select().from(externalOutboundDeliveries);
  assert.equal(delivery?.sourceMessageId, onMessage.id);
  assert.notEqual(delivery?.sourceMessageId, offMessage.id);
  assert.equal(postedBodies.length, 1);
});
