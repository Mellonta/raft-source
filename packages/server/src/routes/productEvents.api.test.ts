import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { productEvents, servers, userAnalyticsIds, users } from "../db/schema";
import { PRODUCT_EVENT_SINK_APP_KEY } from "../services/productEventIngest";
import type { ProductEventRow, ProductEventSink } from "../services/productEventScopeDbWriter";
import { createServer } from "../services/serverService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedVerifiedUser(email: string, name: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}



function authHeaders(token: string, serverId: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Server-Id": serverId,
  };
}

test("POST /product-events/onboarding-wizard records a sanitized core wizard event", async ({ app }) => {
  const owner = await seedVerifiedUser("onboarding-event-owner@slock.test", "onboarding-event-owner");
  const server = await createServer("Onboarding Event Contract", "onboarding-event-contract", owner.id);
  const token = await tokenForHuman(owner.email);

  const res = await fetch(`${app.baseUrl}/api/product-events/onboarding-wizard`, {
    method: "POST",
    headers: authHeaders(token, server.id),
    body: JSON.stringify({
      eventType: "onboarding_wizard.primary_clicked",
      idempotencyKey: "onboarding-event-test-primary",
      metadata: {
        step_id: "referral-source",
        wizard_version: "owner-wizard-v3",
        session_id: "session-123",
        action: "submit_referral",
        result: "twitter_x",
        reason: "ignored-but-allowed",
        latency_ms: 123.4,
        raw_text: "must not be stored",
      },
    }),
  });
  assert.equal(res.status, 204, `record event must succeed (status=${res.status})`);

  const rows = await getDb().select().from(productEvents).where(
    and(
      eq(productEvents.subjectType, "onboarding_wizard"),
      eq(productEvents.subjectId, server.id),
      eq(productEvents.eventType, "onboarding_wizard.primary_clicked"),
    ),
  );

  assert.equal(rows.length, 1);
  const [event] = rows;
  assert.equal(event.actorType, "human");
  assert.equal(event.actorId, owner.id);
  assert.equal(event.source, "web");
  assert.equal(event.idempotencyKey, "onboarding-event-test-primary");
  assert.deepEqual(event.metadata, {
    step_id: "referral-source",
    wizard_version: "owner-wizard-v3",
    session_id: "session-123",
    action: "submit_referral",
    result: "twitter_x",
    reason: "ignored-but-allowed",
    latency_ms: 123,
  });
});

test("POST /product-events/onboarding-wizard rejects untracked push-notification steps", async ({ app }) => {
  const owner = await seedVerifiedUser("onboarding-event-push@slock.test", "onboarding-event-push");
  const server = await createServer("Onboarding Push Exclusion", "onboarding-push-exclusion", owner.id);
  const token = await tokenForHuman(owner.email);

  const res = await fetch(`${app.baseUrl}/api/product-events/onboarding-wizard`, {
    method: "POST",
    headers: authHeaders(token, server.id),
    body: JSON.stringify({
      eventType: "onboarding_wizard.step_shown",
      metadata: {
        step_id: "enable-notifications",
        wizard_version: "owner-wizard-v3",
        session_id: "session-123",
      },
    }),
  });
  assert.equal(res.status, 400);
  const body = await res.json() as { error?: string };
  assert.match(body.error ?? "", /tracked onboarding wizard step/i);

  const rows = await getDb().select().from(productEvents).where(eq(productEvents.subjectId, server.id));
  assert.equal(rows.length, 0);
});

// RFC-067 client behavior events.

function memoryProductEventSink() {
  const rows: ProductEventRow[] = [];
  return {
    rows,
    sink: {
      enqueue(batch: readonly ProductEventRow[]) {
        rows.push(...batch);
      },
      async flush() {},
    } satisfies ProductEventSink,
  };
}

const SESSION_ID = "8f6c3e2a-1b4d-4c5e-9f7a-2b3c4d5e6f70";

function clientEvent(event: string, properties: Record<string, unknown>, timestamp = new Date().toISOString()) {
  return { uuid: randomUUID(), event, timestamp, client_session_id: SESSION_ID, properties };
}

test("client events: nothing is accepted until the user shares usage data", async ({ app }) => {
  const user = await seedVerifiedUser("client-events-default@slock.test", "client-events-default");
  const server = await createServer("Client Events Default", "client-events-default", user.id);
  const token = await tokenForHuman(user.email);
  const store = memoryProductEventSink();
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, store.sink);

  const config = await fetch(`${app.baseUrl}/api/product-events/config`, { headers: authHeaders(token, server.id) });
  assert.deepEqual(await config.json(), { clientEventsAllowed: false });

  const res = await fetch(`${app.baseUrl}/api/product-events/batch`, {
    method: "POST",
    headers: authHeaders(token, server.id),
    body: JSON.stringify({ source: "web", events: [clientEvent("activity_open", { from: "rail" })] }),
  });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { accepted: 0 });
  assert.equal(store.rows.length, 0);
});

test("client events: registered events are stored under the analytics id only", async ({ app }) => {
  const user = await seedVerifiedUser("client-events-on@slock.test", "client-events-on");
  const server = await createServer("Client Events On", "client-events-on", user.id);
  await getDb().update(users).set({ shareUsageData: true }).where(eq(users.id, user.id));
  const token = await tokenForHuman(user.email);
  const store = memoryProductEventSink();
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, store.sink);

  const config = await fetch(`${app.baseUrl}/api/product-events/config`, { headers: authHeaders(token, server.id) });
  assert.deepEqual(await config.json(), { clientEventsAllowed: true });

  const res = await fetch(`${app.baseUrl}/api/product-events/batch`, {
    method: "POST",
    headers: authHeaders(token, server.id),
    body: JSON.stringify({
      source: "web",
      app_version: "1.2.3",
      events: [
        clientEvent("activity_open", { from: "rail" }),
        clientEvent("activity_open", { from: "rail", text: "hello" }), // unknown property
        clientEvent("button_clicked", {}), // unregistered
        clientEvent("activity_mark", { action: "done" }, "2020-01-01T00:00:00.000Z"), // stale
      ],
    }),
  });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { accepted: 1 });

  const [mapping] = await getDb().select().from(userAnalyticsIds).where(eq(userAnalyticsIds.userId, user.id));
  assert.equal(store.rows.length, 1);
  const [row] = store.rows;
  assert.equal(row.event, "activity_open");
  assert.equal(row.analytics_id, mapping.analyticsId);
  assert.equal(row.server_id, server.id);
  assert.equal(row.source, "web");
  assert.equal(row.client_session_id, SESSION_ID);
  assert.equal(row.app_version, "1.2.3");
  assert.deepEqual(row.properties, { from: "rail" });
  assert.doesNotMatch(JSON.stringify(store.rows), new RegExp(user.id), "the Raft user id must not reach the store");
});

test("client events: a malformed batch is rejected", async ({ app }) => {
  const user = await seedVerifiedUser("client-events-bad@slock.test", "client-events-bad");
  const server = await createServer("Client Events Bad", "client-events-bad", user.id);
  const token = await tokenForHuman(user.email);
  const res = await fetch(`${app.baseUrl}/api/product-events/batch`, {
    method: "POST",
    headers: authHeaders(token, server.id),
    body: JSON.stringify({ source: "web", events: [{ event: "activity_open" }] }),
  });
  assert.equal(res.status, 400);
});

test("client events: duplicates are dropped and malformed ids or versions are rejected", async ({ app }) => {
  const user = await seedVerifiedUser("client-events-dedupe@slock.test", "client-events-dedupe");
  const server = await createServer("Client Events Dedupe", "client-events-dedupe", user.id);
  await getDb().update(users).set({ shareUsageData: true }).where(eq(users.id, user.id));
  const token = await tokenForHuman(user.email);
  const store = memoryProductEventSink();
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, store.sink);
  const post = (body: unknown) => fetch(`${app.baseUrl}/api/product-events/batch`, {
    method: "POST",
    headers: authHeaders(token, server.id),
    body: JSON.stringify(body),
  });

  const event = { ...clientEvent("activity_open", { from: "rail" }), client_session_id: randomUUID() };
  const first = await post({ source: "web", events: [event, event] });
  assert.deepEqual(await first.json(), { accepted: 1 }, "a repeated uuid in one batch is stored once");
  const again = await post({ source: "web", events: [event] });
  assert.deepEqual(await again.json(), { accepted: 0 }, "a recently seen uuid is dropped");
  assert.equal(store.rows.length, 1);

  const badSession = await post({ source: "web", events: [{ ...clientEvent("activity_open", {}), client_session_id: "tab-1 <script>" }] });
  assert.equal(badSession.status, 400);
  const badVersion = await post({ source: "web", app_version: "1.0 (beta)", events: [clientEvent("activity_open", {})] });
  assert.equal(badVersion.status, 400);
});

test("onboarding-wizard events honor an explicit opt-out and the workspace switch", async ({ app }) => {
  const owner = await seedVerifiedUser("wizard-opt-out@slock.test", "wizard-opt-out");
  const server = await createServer("Wizard Opt Out", "wizard-opt-out", owner.id);
  const token = await tokenForHuman(owner.email);
  const record = (key: string) => fetch(`${app.baseUrl}/api/product-events/onboarding-wizard`, {
    method: "POST",
    headers: authHeaders(token, server.id),
    body: JSON.stringify({ eventType: "onboarding_wizard.step_shown", idempotencyKey: key, metadata: { step_id: "create-agent" } }),
  });
  const count = async () => (await getDb().select().from(productEvents).where(eq(productEvents.subjectId, server.id))).length;

  assert.equal((await record("not-chosen")).status, 204);
  assert.equal(await count(), 1, "not chosen yet: still recorded for existing readers");

  await getDb().update(users).set({ shareUsageData: false }).where(eq(users.id, owner.id));
  assert.equal((await record("opted-out")).status, 204);
  assert.equal(await count(), 1, "the user turned sharing off: nothing recorded");

  await getDb().update(users).set({ shareUsageData: null }).where(eq(users.id, owner.id));
  await getDb().update(servers).set({ productAnalyticsEnabled: false }).where(eq(servers.id, server.id));
  assert.equal((await record("workspace-off")).status, 204);
  assert.equal(await count(), 1, "the workspace turned analytics off: nothing recorded");
});
