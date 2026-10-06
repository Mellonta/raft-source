/**
 * App login handoff (HarmonyOS web login, #raft-mobile-reconcile:9607096f).
 *
 * A native app starts a request with a PKCE S256 challenge and a return URI
 * from a fixed allowlist, then opens `/login/app?request=<id>` in the system
 * browser. The ordinary web login runs there (any method, including a GitHub
 * round trip). The signed-in user explicitly confirms, which issues a
 * one-time code; the browser jumps to the return URI saved at start. The app
 * exchanges code + verifier for a normal user session.
 *
 * Deliberately separate from the mobile OAuth handoff: there is no provider
 * and no provider callback. Only the code is secret; it is stored as a
 * sha256 hash and consumed once by compare-and-set.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "../db/index";
import { appLoginRequests } from "../db/schema";
import { currentDate } from "@botiverse/raft-shared";

export const APP_LOGIN_REQUEST_TTL_MS = 10 * 60_000;

const DEFAULT_APP_LOGIN_RETURN_URIS = [
  "raft://login/callback",
  "raft-alpha://login/callback",
  "raft-beta://login/callback",
  "raft-debug://login/callback",
];

export function allowedAppLoginReturnUris(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.APP_LOGIN_RETURN_URIS?.trim();
  if (!raw) return DEFAULT_APP_LOGIN_RETURN_URIS;
  return raw.split(/[\n,]/).map((uri) => uri.trim()).filter(Boolean);
}

export type AppLoginStartError = "return_uri_not_allowed" | "code_challenge_invalid";
export type AppLoginResolveError = "request_not_found" | "request_expired" | "request_already_resolved";
export type AppLoginExchangeError = "code_not_found" | "code_expired" | "code_consumed" | "pkce_mismatch";

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export async function startAppLogin(input: { returnUri: string; codeChallenge: string }): Promise<
  | { ok: true; requestId: string; expiresAt: Date }
  | { ok: false; error: AppLoginStartError }
> {
  if (!allowedAppLoginReturnUris().includes(input.returnUri)) return { ok: false, error: "return_uri_not_allowed" };
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(input.codeChallenge)) return { ok: false, error: "code_challenge_invalid" };
  const expiresAt = new Date(currentDate().getTime() + APP_LOGIN_REQUEST_TTL_MS);
  const [row] = await getDb().insert(appLoginRequests).values({
    codeChallenge: input.codeChallenge,
    returnUri: input.returnUri,
    expiresAt,
  }).returning({ id: appLoginRequests.id });
  return { ok: true, requestId: row!.id, expiresAt };
}

async function loadPending(requestId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) return { ok: false as const, error: "request_not_found" as const };
  const [row] = await getDb().select().from(appLoginRequests).where(eq(appLoginRequests.id, requestId)).limit(1);
  if (!row) return { ok: false as const, error: "request_not_found" as const };
  if (row.status !== "pending") return { ok: false as const, error: "request_already_resolved" as const, row };
  if (row.expiresAt.getTime() <= currentDate().getTime()) return { ok: false as const, error: "request_expired" as const, row };
  return { ok: true as const, row };
}

/** Every callback names its request, so an app that retried can ignore a
 * late callback from an earlier attempt before exchanging anything. */
function callbackUrl(returnUri: string, requestId: string, params: Record<string, string>): string {
  const url = new URL(returnUri);
  url.searchParams.set("requestId", requestId);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** What the confirmation page needs; the return URI is included so a
 * cancel on an expired request can still hand control back to the app. */
export async function describeAppLogin(requestId: string): Promise<
  | { ok: true; expiresAt: Date }
  | { ok: false; error: AppLoginResolveError; cancelUrl?: string }
> {
  const pending = await loadPending(requestId);
  if (pending.ok) return { ok: true, expiresAt: pending.row.expiresAt };
  if (pending.error === "request_expired") {
    return { ok: false, error: pending.error, cancelUrl: callbackUrl(pending.row!.returnUri, requestId, { error: "expired" }) };
  }
  return { ok: false, error: pending.error };
}

/** The signed-in user confirmed: bind them, mint the one-time code, and
 * return the saved return URI with it. */
export async function approveAppLogin(requestId: string, userId: string): Promise<
  | { ok: true; redirectUrl: string }
  | { ok: false; error: AppLoginResolveError; redirectUrl?: string }
> {
  const pending = await loadPending(requestId);
  if (!pending.ok) {
    return pending.error === "request_expired"
      ? { ok: false, error: pending.error, redirectUrl: callbackUrl(pending.row!.returnUri, requestId, { error: "expired" }) }
      : { ok: false, error: pending.error };
  }
  const code = randomBytes(32).toString("base64url");
  const [updated] = await getDb().update(appLoginRequests)
    .set({ status: "approved", userId, codeHash: hashCode(code), approvedAt: currentDate() })
    .where(and(
      eq(appLoginRequests.id, requestId),
      eq(appLoginRequests.status, "pending"),
      gt(appLoginRequests.expiresAt, currentDate()),
    ))
    .returning({ returnUri: appLoginRequests.returnUri });
  if (!updated) return { ok: false, error: "request_already_resolved" };
  return { ok: true, redirectUrl: callbackUrl(updated.returnUri, requestId, { code }) };
}

export async function denyAppLogin(requestId: string): Promise<
  | { ok: true; redirectUrl: string }
  | { ok: false; error: AppLoginResolveError }
> {
  const pending = await loadPending(requestId);
  if (!pending.ok) {
    return pending.error === "request_expired"
      ? { ok: true, redirectUrl: callbackUrl(pending.row!.returnUri, requestId, { error: "expired" }) }
      : { ok: false, error: pending.error };
  }
  const [updated] = await getDb().update(appLoginRequests)
    .set({ status: "denied" })
    .where(and(eq(appLoginRequests.id, requestId), eq(appLoginRequests.status, "pending")))
    .returning({ returnUri: appLoginRequests.returnUri });
  if (!updated) return { ok: false, error: "request_already_resolved" };
  return { ok: true, redirectUrl: callbackUrl(updated.returnUri, requestId, { error: "access_denied" }) };
}

/** Single-use exchange. A wrong verifier does not burn the code: only the
 * device holding the verifier can use it, and a failed guess reveals
 * nothing. */
export async function exchangeAppLoginCode(code: string, codeVerifier: string): Promise<
  | { ok: true; userId: string }
  | { ok: false; error: AppLoginExchangeError }
> {
  if (!code || code.length > 256) return { ok: false, error: "code_not_found" };
  const [row] = await getDb().select().from(appLoginRequests)
    .where(eq(appLoginRequests.codeHash, hashCode(code))).limit(1);
  if (!row || !row.userId) return { ok: false, error: "code_not_found" };
  if (row.status === "completed") return { ok: false, error: "code_consumed" };
  if (row.expiresAt.getTime() <= currentDate().getTime()) return { ok: false, error: "code_expired" };
  if (!codeVerifier || pkceChallenge(codeVerifier) !== row.codeChallenge) return { ok: false, error: "pkce_mismatch" };
  const [consumed] = await getDb().update(appLoginRequests)
    .set({ status: "completed", consumedAt: currentDate() })
    .where(and(
      eq(appLoginRequests.id, row.id),
      eq(appLoginRequests.status, "approved"),
      isNull(appLoginRequests.consumedAt),
    ))
    .returning({ userId: appLoginRequests.userId });
  if (!consumed?.userId) return { ok: false, error: "code_consumed" };
  return { ok: true, userId: consumed.userId };
}
