import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "vitest";

import argon2 from "argon2";

import { getDb } from "../db/index";
import { appLoginRequests, users } from "../db/schema";
import { eq } from "drizzle-orm";
import { openTestApp } from "../test/integration/app";
import { signAccessToken } from "../middleware/auth";

// App login handoff (HarmonyOS web login): app starts with a PKCE challenge,
// the signed-in web user explicitly approves, the app exchanges the one-time
// code + verifier for a normal session. Pins: return-URI allowlist, explicit
// approve/deny, callback carries only code/error, single use, PKCE binding,
// expiry, and a usable session at the end.

const RETURN_URI = "raft://login/callback";

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "Content-Type": "application/json", ...extra };
}

function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function withApp<T>(fn: (app: Awaited<ReturnType<typeof openTestApp>>) => Promise<T>): Promise<T> {
  const oldAppUrl = process.env.APP_URL;
  process.env.APP_URL = "https://app.raft.test";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    return await fn(app);
  } finally {
    await app.close();
    if (oldAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = oldAppUrl;
  }
}

async function seedUser(): Promise<{ id: string; email: string; bearer: string }> {
  const suffix = randomUUID();
  const [u] = await getDb()
    .insert(users)
    .values({
      email: `app-login-${suffix}@slock.test`,
      name: `app-login-${suffix}`,
      displayName: "App Login Tester",
      passwordHash: await argon2.hash("password123"),
      emailVerified: true,
    })
    .returning();
  return { id: u.id, email: u.email, bearer: signAccessToken(u.id) };
}

async function start(baseUrl: string, body: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/auth/app-login/start`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify(body) });
}

test("app login: start → explicit approve → one-time code exchange issues a working session", async () => {
  await withApp(async (app) => {
    const user = await seedUser();
    const { verifier, challenge } = pkcePair();

    const startRes = await start(app.baseUrl, { returnUri: RETURN_URI, codeChallenge: challenge });
    assert.equal(startRes.status, 201);
    const started = await startRes.json() as { requestId: string; loginUrl: string; expiresAt: string };
    assert.equal(started.loginUrl, `https://app.raft.test/login/app?request=${started.requestId}`);

    // The confirmation page can read the request only when signed in.
    const anonymous = await fetch(`${app.baseUrl}/api/auth/app-login/requests/${started.requestId}`);
    assert.equal(anonymous.status, 401);
    const described = await fetch(`${app.baseUrl}/api/auth/app-login/requests/${started.requestId}`, {
      headers: { Authorization: `Bearer ${user.bearer}` },
    });
    assert.equal(described.status, 200);

    const approveRes = await fetch(`${app.baseUrl}/api/auth/app-login/requests/${started.requestId}/approve`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${user.bearer}` }),
    });
    assert.equal(approveRes.status, 200);
    const { redirectUrl } = await approveRes.json() as { redirectUrl: string };
    const callback = new URL(redirectUrl);
    assert.equal(`${callback.protocol}//${callback.host}${callback.pathname}`, RETURN_URI);
    assert.deepEqual([...callback.searchParams.keys()], ["requestId", "code"], "callback carries the request id and the one-time code only");
    assert.equal(callback.searchParams.get("requestId"), started.requestId);
    const code = callback.searchParams.get("code")!;

    // A second approval cannot mint another code.
    const again = await fetch(`${app.baseUrl}/api/auth/app-login/requests/${started.requestId}/approve`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${user.bearer}` }),
    });
    assert.equal(again.status, 409);

    // Wrong verifier is refused and does not burn the code.
    const wrong = await fetch(`${app.baseUrl}/api/auth/app-login/complete`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ code, codeVerifier: pkcePair().verifier }),
    });
    assert.equal(wrong.status, 400);
    assert.equal((await wrong.json() as { code: string }).code, "pkce_mismatch");

    const completeRes = await fetch(`${app.baseUrl}/api/auth/app-login/complete`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ code, codeVerifier: verifier }),
    });
    assert.equal(completeRes.status, 200);
    const session = await completeRes.json() as { user: { id: string }; accessToken: string; refreshToken: string };
    assert.equal(session.user.id, user.id);
    assert.ok(session.refreshToken);
    const me = await fetch(`${app.baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${session.accessToken}` } });
    assert.equal(me.status, 200);

    const replay = await fetch(`${app.baseUrl}/api/auth/app-login/complete`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ code, codeVerifier: verifier }),
    });
    assert.equal(replay.status, 410);
    assert.equal((await replay.json() as { code: string }).code, "code_consumed");
  });
});

test("app login: only allowlisted return URIs and S256 challenges start a request", async () => {
  await withApp(async (app) => {
    const { challenge } = pkcePair();
    for (const returnUri of ["raft://oauth/callback", "https://evil.test/cb", "raft://login/callback/extra"]) {
      const res = await start(app.baseUrl, { returnUri, codeChallenge: challenge });
      assert.equal(res.status, 400, returnUri);
      assert.equal((await res.json() as { code: string }).code, "return_uri_not_allowed");
    }
    // HarmonyOS's shared request DTO also sends platform / appEnv / method.
    const debug = await start(app.baseUrl, {
      returnUri: "raft-debug://login/callback",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      platform: "ohos",
      appEnv: "staging",
    });
    assert.equal(debug.status, 201);
    const plainMethod = await start(app.baseUrl, { returnUri: RETURN_URI, codeChallenge: challenge, codeChallengeMethod: "plain" });
    assert.equal(plainMethod.status, 400);
    const plain = await start(app.baseUrl, { returnUri: RETURN_URI, codeChallenge: "short" });
    assert.equal(plain.status, 400);
    assert.equal((await plain.json() as { code: string }).code, "code_challenge_invalid");
  });
});

test("app login: deny returns access_denied to the app, and an expired request reports expired", async () => {
  await withApp(async (app) => {
    const user = await seedUser();
    const auth = jsonHeaders({ Authorization: `Bearer ${user.bearer}` });

    const denied = await (await start(app.baseUrl, { returnUri: RETURN_URI, codeChallenge: pkcePair().challenge })).json() as { requestId: string };
    const denyRes = await fetch(`${app.baseUrl}/api/auth/app-login/requests/${denied.requestId}/deny`, { method: "POST", headers: auth });
    assert.equal(denyRes.status, 200);
    assert.equal((await denyRes.json() as { redirectUrl: string }).redirectUrl, `${RETURN_URI}?requestId=${denied.requestId}&error=access_denied`);
    const approveAfterDeny = await fetch(`${app.baseUrl}/api/auth/app-login/requests/${denied.requestId}/approve`, { method: "POST", headers: auth });
    assert.equal(approveAfterDeny.status, 409);

    const expired = await (await start(app.baseUrl, { returnUri: RETURN_URI, codeChallenge: pkcePair().challenge })).json() as { requestId: string };
    await getDb().update(appLoginRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(appLoginRequests.id, expired.requestId));
    const approveExpired = await fetch(`${app.baseUrl}/api/auth/app-login/requests/${expired.requestId}/approve`, { method: "POST", headers: auth });
    assert.equal(approveExpired.status, 410);
    const body = await approveExpired.json() as { code: string; redirectUrl: string };
    assert.equal(body.code, "request_expired");
    assert.equal(body.redirectUrl, `${RETURN_URI}?requestId=${expired.requestId}&error=expired`);

    const unknown = await fetch(`${app.baseUrl}/api/auth/app-login/requests/${randomUUID()}/approve`, { method: "POST", headers: auth });
    assert.equal(unknown.status, 404);
  });
});

test("app login: an approved code expires with its request", async () => {
  await withApp(async (app) => {
    const user = await seedUser();
    const { verifier, challenge } = pkcePair();
    const started = await (await start(app.baseUrl, { returnUri: RETURN_URI, codeChallenge: challenge })).json() as { requestId: string };
    const approved = await (await fetch(`${app.baseUrl}/api/auth/app-login/requests/${started.requestId}/approve`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${user.bearer}` }),
    })).json() as { redirectUrl: string };
    const code = new URL(approved.redirectUrl).searchParams.get("code")!;
    await getDb().update(appLoginRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(appLoginRequests.id, started.requestId));
    const res = await fetch(`${app.baseUrl}/api/auth/app-login/complete`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ code, codeVerifier: verifier }),
    });
    assert.equal(res.status, 410);
    assert.equal((await res.json() as { code: string }).code, "code_expired");
  });
});
