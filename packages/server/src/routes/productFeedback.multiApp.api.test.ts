import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { featureFlags, integrationSecretCommitments, users } from "../db/schema";
import { signAccessToken } from "../middleware/auth";
import { resetProductFeedbackRouteBindingCacheForTest } from "../services/productFeedbackRouteBindingService";
import {
  resetProductFeedbackBreakersForTest,
  resetProductFeedbackReporterSessionCacheForTest,
} from "../services/productFeedbackConversationService";
import {
  CachedProductFeedbackApps,
  PRODUCT_FEEDBACK_MULTI_APP_FLAG,
  setProductFeedbackAppsForTest,
} from "../services/productFeedbackApps";

const test = createApiTest();

const ANDROID_APP_ID = "a48a84f8-04ed-4db3-9297-189a14a36afc";
const ANDROID_INTEGRATION_ID = "a7df6737-1452-4680-a23a-c321277f53f4";
const LEGACY_APP_ID = "11111111-1111-4111-8111-111111111111";
const IOS_APP_ID = "fbfaceca-6d27-47e1-9c20-e56a39535339";
const ANDROID_TICKET_ID = "33333333-3333-4333-8333-333333333333";
// The fake Hands keeps tickets per app, like Hands: a ticket exists only in
// the app it was filed in.
const TICKETS_BY_APP = new Map([[ANDROID_APP_ID, new Set([ANDROID_TICKET_ID])]]);

type Captured = { method: string; url: string; headers: IncomingMessage["headers"] };

async function withUpstream<T>(run: (baseUrl: string, requests: Captured[]) => Promise<T>): Promise<T> {
  const requests: Captured[] = [];
  const server = createHttpServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    res.setHeader("Content-Type", "application/json");
    if (req.method === "PUT" && req.url?.includes("/reporter-feedback/route-subject")) {
      res.writeHead(201);
      res.end(JSON.stringify({ changed: true, subject_version: "v1" }));
      return;
    }
    if (req.method === "GET" && req.url?.includes("/reporter-feedback?")) {
      res.writeHead(200);
      res.end(JSON.stringify({ tickets: [], next_cursor: "hands-page-2", unread_total: 0 }));
      return;
    }
    const ticketPath = req.url?.match(/^\/api\/apps\/([^/]+)\/reporter-feedback\/([0-9a-f-]{36})(?:[/?]|$)/);
    if (ticketPath && !TICKETS_BY_APP.get(ticketPath[1]!)?.has(ticketPath[2]!)) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (req.method === "POST" && /^\/public\/v2\/apps\/[^/]+\/feedback$/.test(req.url ?? "")) {
      res.writeHead(201);
      res.end(JSON.stringify({ id: "ticket-1", status: "open", attachments: 0 }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: "unexpected request" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`, requests);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const LEGACY_KEYS = [
  "HANDS_FEEDBACK_BASE_URL", "HANDS_FEEDBACK_APP_SLUG", "HANDS_FEEDBACK_CLIENT_KEY", "HANDS_FEEDBACK_APP_TOKEN",
  "HANDS_FEEDBACK_REPORTER_ID_SECRET", "HANDS_FEEDBACK_APP_ID", "HANDS_FEEDBACK_CONVERSATION_APP_TOKEN",
  "HANDS_FEEDBACK_CONVERSATION_CREDENTIAL_REVISION", "HANDS_FEEDBACK_CURSOR_SECRET",
  "HANDS_FEEDBACK_REPORTER_INTEGRATION_ID", "HANDS_FEEDBACK_ROUTE_SUBJECT_KEY_ID", "HANDS_FEEDBACK_ROUTE_SUBJECT_ROOT",
] as const;

async function withEnv<T>(baseUrl: string, run: () => Promise<T>): Promise<T> {
  const previous = new Map(LEGACY_KEYS.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    HANDS_FEEDBACK_BASE_URL: baseUrl,
    HANDS_FEEDBACK_APP_SLUG: "raft-web",
    HANDS_FEEDBACK_CLIENT_KEY: "qk_legacy",
    HANDS_FEEDBACK_APP_TOKEN: "legacy_app_token",
    HANDS_FEEDBACK_REPORTER_ID_SECRET: "legacy-reporter-secret",
    HANDS_FEEDBACK_APP_ID: LEGACY_APP_ID,
    HANDS_FEEDBACK_CONVERSATION_APP_TOKEN: "legacy_conversation_token",
    HANDS_FEEDBACK_CONVERSATION_CREDENTIAL_REVISION: "legacy-revision",
    HANDS_FEEDBACK_CURSOR_SECRET: "legacy-cursor-secret",
    HANDS_FEEDBACK_REPORTER_INTEGRATION_ID: `legacy-feedback:${LEGACY_APP_ID}`,
    HANDS_FEEDBACK_ROUTE_SUBJECT_KEY_ID: "v1",
    HANDS_FEEDBACK_ROUTE_SUBJECT_ROOT: Buffer.alloc(32, 1).toString("base64url"),
  });
  setProductFeedbackAppsForTest(new CachedProductFeedbackApps(
    async () => JSON.stringify({
      shared: {
        reporter_id_secret: "multi-reporter-secret",
        route_subject_root: Buffer.alloc(32, 9).toString("base64url"),
        cursor_secret: "multi-cursor-secret",
      },
      ios: {
        app_slug: "raft-feedback-ios",
        app_id: IOS_APP_ID,
        reporter_integration_id: "9414a84b-7b41-44a2-96b5-b3617ec057cc",
        credential_revision: "1",
        client_key: "qk_ios",
        token: "ios_token",
      },
      android: {
        app_slug: "raft-feedback-android",
        app_id: ANDROID_APP_ID,
        reporter_integration_id: ANDROID_INTEGRATION_ID,
        credential_revision: "1",
        client_key: "qk_android",
        token: "android_token",
      },
    }),
    { HANDS_FEEDBACK_APPS_SSM_PARAMETER: "/slock/staging/HANDS_FEEDBACK_APPS" },
  ));
  resetProductFeedbackRouteBindingCacheForTest();
  resetProductFeedbackReporterSessionCacheForTest();
  resetProductFeedbackBreakersForTest();
  try {
    return await run();
  } finally {
    for (const key of LEGACY_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setProductFeedbackAppsForTest(null);
    resetProductFeedbackRouteBindingCacheForTest();
    resetProductFeedbackReporterSessionCacheForTest();
    resetProductFeedbackBreakersForTest();
  }
}

async function enableMultiAppFlag(): Promise<void> {
  await getDb().insert(featureFlags).values({
    key: PRODUCT_FEEDBACK_MULTI_APP_FLAG,
    description: "test multi-app feedback",
    enabled: true,
    killSwitch: false,
    randomizationUnit: "user",
    defaultEnabled: true,
    salt: "product-feedback-multi-app-test",
  });
}

async function seedToken(): Promise<string> {
  const [user] = await getDb().insert(users).values({
    email: "multi-feedback@slock.test",
    name: "multi-feedback",
    displayName: "Multi Feedback",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return signAccessToken(user!.id);
}

function submitForm(clientKind: string): FormData {
  const form = new FormData();
  form.set("type", "problem");
  form.set("message", `feedback from ${clientKind}`);
  form.set("submission_id", "77777777-7777-4777-8777-777777777777");
  form.set("may_contact", "false");
  form.set("metadata", JSON.stringify({ client_kind: clientKind, platform: clientKind, client_version: "1.0.0" }));
  return form;
}

test("privacy mode refuses a signed-in client's report and inbox without contacting even a configured collector", async ({ app }) => {
  await withUpstream(async (baseUrl, requests) => withEnv(baseUrl, async () => {
    const previous = process.env.RAFT_PRIVACY_MODE;
    process.env.RAFT_PRIVACY_MODE = "1";
    try {
      await enableMultiAppFlag();
      const token = await seedToken();
      const headers = { Authorization: `Bearer ${token}`, "X-Raft-Client-Kind": "android" };
      const report = submitForm("android");
      report.set("attachments", new Blob(["private test attachment"], { type: "image/png" }), "private.png");
      for (const response of [
        await fetch(`${app.baseUrl}/api/product-feedback`, { method: "POST", headers, body: report }),
        await fetch(`${app.baseUrl}/api/product-feedback/tickets`, { headers }),
      ]) {
        assert.equal(response.status, 503);
        assert.equal((await response.json()).code, "feedback_integration_unavailable");
      }
      assert.equal(requests.length, 0);
    } finally {
      if (previous === undefined) delete process.env.RAFT_PRIVACY_MODE;
      else process.env.RAFT_PRIVACY_MODE = previous;
    }
  }));
});

test("flag on: an Android submit and list reach the Android app with its own token and route root", async ({ app }) => {
  await withUpstream(async (baseUrl, requests) => withEnv(baseUrl, async () => {
    await enableMultiAppFlag();
    const token = await seedToken();
    const submitted = await fetch(`${app.baseUrl}/api/product-feedback`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-Raft-Client-Kind": "android" },
      body: submitForm("android"),
    });
    assert.equal(submitted.status, 201, await submitted.clone().text());

    const submit = requests.find((request) => request.method === "POST" && request.url.endsWith("/feedback"));
    assert.equal(submit?.url, "/public/v2/apps/raft-feedback-android/feedback");
    assert.equal(submit?.headers["x-hands-client-key"], "qk_android");
    assert.equal(submit?.headers.authorization, "Bearer android_token");
    const binding = requests.find((request) => request.method === "PUT");
    assert.equal(binding?.url, `/api/apps/${ANDROID_APP_ID}/reporter-feedback/route-subject`);
    assert.equal(binding?.headers.authorization, "Bearer android_token");

    const listed = await fetch(`${app.baseUrl}/api/product-feedback/tickets`, {
      headers: { Authorization: `Bearer ${token}`, "X-Raft-Client-Kind": "android" },
    });
    assert.equal(listed.status, 200, await listed.clone().text());
    const list = requests.find((request) => request.method === "GET");
    assert.ok(list?.url.startsWith(`/api/apps/${ANDROID_APP_ID}/reporter-feedback?`), list?.url);
    assert.equal(requests.some((request) => request.url.includes(LEGACY_APP_ID) || request.url.includes("raft-web")), false);

    // The shared multi root is committed under its own label, beside (not over) the legacy one.
    const labels = (await getDb().select({ label: integrationSecretCommitments.label }).from(integrationSecretCommitments))
      .map((row) => row.label);
    assert.deepEqual(labels, ["hands-feedback-route-subject:multi:v1"]);
  }));
});

test("flag on: a mobile source with no app answers 503 without touching the legacy app", async ({ app }) => {
  await withUpstream(async (baseUrl, requests) => withEnv(baseUrl, async () => {
    await enableMultiAppFlag();
    const token = await seedToken();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      const submitted = await fetch(`${app.baseUrl}/api/product-feedback`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "X-Raft-Client-Kind": "ohos" },
        body: submitForm("ohos"),
      });
      assert.equal(submitted.status, 503);
      assert.equal((await submitted.json() as { code: string }).code, "feedback_integration_unavailable");
      const listed = await fetch(`${app.baseUrl}/api/product-feedback/tickets`, {
        headers: { Authorization: `Bearer ${token}`, "X-Raft-Client-Kind": "ohos" },
      });
      assert.equal(listed.status, 503);
      assert.equal((await listed.json() as { code: string }).code, "feedback_integration_unavailable");
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(requests.length, 0, "no Hands traffic for an unconfigured source");
    assert.deepEqual(warnings.filter((line) => line.includes("source unavailable")), [
      "[product-feedback] source unavailable (ohos: source_entry_missing)",
      "[product-feedback] source unavailable (ohos: source_entry_missing)",
    ]);
  }));
});

test("flag on: a route binding failure answers 503 and logs its reason without any value", async ({ app }) => {
  await withUpstream(async (baseUrl, requests) => withEnv(baseUrl, async () => {
    await enableMultiAppFlag();
    const token = await seedToken();
    // A malformed shared root (hex, not 43-char base64url) fails route binding before Hands.
    const badRoot = "ab".repeat(32);
    setProductFeedbackAppsForTest(new CachedProductFeedbackApps(
      async () => JSON.stringify({
        shared: { reporter_id_secret: "multi-reporter-secret", route_subject_root: badRoot, cursor_secret: "multi-cursor-secret" },
        android: {
          app_slug: "raft-feedback-android",
          app_id: ANDROID_APP_ID,
          reporter_integration_id: ANDROID_INTEGRATION_ID,
          credential_revision: "1",
          client_key: "qk_android",
          token: "android_token",
        },
      }),
      { HANDS_FEEDBACK_APPS_SSM_PARAMETER: "/slock/staging/HANDS_FEEDBACK_APPS" },
    ));
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      const listed = await fetch(`${app.baseUrl}/api/product-feedback/tickets`, {
        headers: { Authorization: `Bearer ${token}`, "X-Raft-Client-Kind": "android" },
      });
      assert.equal(listed.status, 503);
      assert.equal(listed.headers.get("retry-after"), "5", "a binding failure tells clients when to retry");
      assert.equal((await listed.json() as { code: string }).code, "feedback_integration_unavailable");
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(requests.length, 0, "route binding fails before any Hands traffic");
    const lines = warnings.filter((line) => line.includes("[product-feedback]"));
    assert.deepEqual(lines, ["[product-feedback] route binding failed (root_invalid)"]);
    for (const secret of [badRoot, "android_token", "qk_android", "multi-reporter-secret", "multi-cursor-secret"]) {
      assert.equal(lines.some((line) => line.includes(secret)), false);
    }
  }));
});

test("flag on: web without its own entry keeps the legacy web app; flag off ignores the apps JSON", async ({ app }) => {
  await withUpstream(async (baseUrl, requests) => withEnv(baseUrl, async () => {
    const token = await seedToken();
    const flagOff = await fetch(`${app.baseUrl}/api/product-feedback/tickets`, {
      headers: { Authorization: `Bearer ${token}`, "X-Raft-Client-Kind": "android" },
    });
    assert.equal(flagOff.status, 200);
    assert.ok(requests.at(-1)?.url.startsWith(`/api/apps/${LEGACY_APP_ID}/reporter-feedback?`), "flag off: legacy app");

    await enableMultiAppFlag();
    resetProductFeedbackRouteBindingCacheForTest();
    const web = await fetch(`${app.baseUrl}/api/product-feedback/tickets`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(web.status, 200);
    assert.ok(requests.at(-1)?.url.startsWith(`/api/apps/${LEGACY_APP_ID}/reporter-feedback?`), "web: legacy app");
  }));
});

test("an unknown client kind on a conversation request is invalid", async ({ app }) => {
  await withUpstream(async (baseUrl, requests) => withEnv(baseUrl, async () => {
    const token = await seedToken();
    const response = await fetch(`${app.baseUrl}/api/product-feedback/tickets`, {
      headers: { Authorization: `Bearer ${token}`, "X-Raft-Client-Kind": "symbian" },
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { code: string }).code, "feedback_invalid");
    assert.equal(requests.length, 0);
  }));
});

test("flag on: an Android ticket id is not found from any other source, on every ticket endpoint", async ({ app }) => {
  await withUpstream(async (baseUrl, requests) => withEnv(baseUrl, async () => {
    await enableMultiAppFlag();
    const token = await seedToken();
    for (const clientKind of ["ios", "web"] as const) {
      const headers = { Authorization: `Bearer ${token}`, "X-Raft-Client-Kind": clientKind };
      const before = requests.length;
      const comment = new FormData();
      comment.set("body", "reply from the wrong source");
      comment.set("submission_id", "44444444-4444-4444-8444-444444444444");
      const responses = await Promise.all([
        fetch(`${app.baseUrl}/api/product-feedback/tickets/${ANDROID_TICKET_ID}`, { headers }),
        fetch(`${app.baseUrl}/api/product-feedback/tickets/${ANDROID_TICKET_ID}/comments`, { method: "POST", headers, body: comment }),
        fetch(`${app.baseUrl}/api/product-feedback/tickets/${ANDROID_TICKET_ID}/close`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "completed" }),
        }),
        fetch(`${app.baseUrl}/api/product-feedback/tickets/${ANDROID_TICKET_ID}/attachments/55555555-5555-4555-8555-555555555555`, { headers }),
      ]);
      for (const response of responses) {
        assert.equal(response.status, 404, `${clientKind} ${response.url}: ${await response.clone().text()}`);
        assert.equal((await response.json() as { code: string }).code, "feedback_not_found");
      }
      const ticketRequests = requests.slice(before).filter((request) => request.url.includes(ANDROID_TICKET_ID));
      assert.equal(ticketRequests.length, 4, `${clientKind}: each endpoint asked its own app once`);
      const expectedAppId = clientKind === "ios" ? IOS_APP_ID : LEGACY_APP_ID;
      for (const request of ticketRequests) {
        assert.ok(request.url.startsWith(`/api/apps/${expectedAppId}/`), `${clientKind} must stay in its app: ${request.url}`);
      }
    }
    assert.equal(requests.some((request) => request.url.startsWith(`/api/apps/${ANDROID_APP_ID}/reporter-feedback/${ANDROID_TICKET_ID}`)), false);
  }));
});

test("flag on: a list cursor minted for Android does not replay on iOS", async ({ app }) => {
  await withUpstream(async (baseUrl, requests) => withEnv(baseUrl, async () => {
    await enableMultiAppFlag();
    const token = await seedToken();
    const androidList = await fetch(`${app.baseUrl}/api/product-feedback/tickets`, {
      headers: { Authorization: `Bearer ${token}`, "X-Raft-Client-Kind": "android" },
    });
    assert.equal(androidList.status, 200);
    const { next_cursor: cursor } = await androidList.json() as { next_cursor: string };
    assert.ok(cursor);

    const androidPage = await fetch(`${app.baseUrl}/api/product-feedback/tickets?cursor=${encodeURIComponent(cursor)}`, {
      headers: { Authorization: `Bearer ${token}`, "X-Raft-Client-Kind": "android" },
    });
    assert.equal(androidPage.status, 200, "the cursor works on its own source");

    const listsBefore = requests.filter((request) => request.method === "GET").length;
    const iosReplay = await fetch(`${app.baseUrl}/api/product-feedback/tickets?cursor=${encodeURIComponent(cursor)}`, {
      headers: { Authorization: `Bearer ${token}`, "X-Raft-Client-Kind": "ios" },
    });
    assert.equal(iosReplay.status, 400);
    assert.equal((await iosReplay.json() as { code: string }).code, "feedback_invalid");
    assert.equal(requests.filter((request) => request.method === "GET").length, listsBefore, "the replay never reaches Hands");
  }));
});
