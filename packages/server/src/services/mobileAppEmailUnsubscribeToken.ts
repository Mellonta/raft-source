import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeDisplayLocale, type DisplayLocale } from "@botiverse/raft-shared";

const TOKEN_KIND = "mobile-app-email-unsubscribe";
const TOKEN_VERSION = 1;
const MAX_TOKEN_LENGTH = 512;
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type MobileAppEmailUnsubscribeClaims = {
  v: typeof TOKEN_VERSION;
  typ: typeof TOKEN_KIND;
  sub: string;
  locale: DisplayLocale;
};

export type MobileAppEmailUnsubscribeIdentity = {
  userId: string;
  locale: DisplayLocale;
};

function signingSecret(): string {
  const secret = process.env.MOBILE_APP_EMAIL_UNSUBSCRIBE_SECRET?.trim()
    || process.env.JWT_SECRET?.trim();
  if (!secret) {
    throw new Error("MOBILE_APP_EMAIL_UNSUBSCRIBE_SECRET or JWT_SECRET is required");
  }
  return secret;
}

function signatureFor(payload: string): string {
  return createHmac("sha256", signingSecret())
    .update(`${TOKEN_KIND}:v${TOKEN_VERSION}:${payload}`)
    .digest("base64url");
}

function serverOrigin(): string {
  const raw = process.env.SERVER_URL?.trim()
    || `http://localhost:${process.env.PORT || 3001}`;
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("SERVER_URL must be an HTTP(S) origin");
  }
  return parsed.origin;
}

export function createMobileAppEmailUnsubscribeToken(
  userId: string,
  locale?: string | null,
): string {
  if (!USER_ID_PATTERN.test(userId)) {
    throw new Error("A valid user ID is required for a mobile email unsubscribe token");
  }
  const claims: MobileAppEmailUnsubscribeClaims = {
    v: TOKEN_VERSION,
    typ: TOKEN_KIND,
    sub: userId,
    locale: normalizeDisplayLocale(locale) ?? "en",
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${signatureFor(payload)}`;
}

export function verifyMobileAppEmailUnsubscribeToken(
  token: unknown,
): MobileAppEmailUnsubscribeIdentity | null {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return null;
  }
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra !== undefined) return null;

  const expectedSignature = Buffer.from(signatureFor(payload), "utf8");
  const candidateSignature = Buffer.from(suppliedSignature, "utf8");
  if (
    expectedSignature.length !== candidateSignature.length
    || !timingSafeEqual(expectedSignature, candidateSignature)
  ) {
    return null;
  }

  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Partial<MobileAppEmailUnsubscribeClaims>;
    const keys = Object.keys(claims).sort();
    const locale = normalizeDisplayLocale(claims.locale);
    if (
      keys.join(",") !== "locale,sub,typ,v"
      || claims.v !== TOKEN_VERSION
      || claims.typ !== TOKEN_KIND
      || typeof claims.sub !== "string"
      || !USER_ID_PATTERN.test(claims.sub)
      || !locale
      || locale !== claims.locale
    ) {
      return null;
    }
    return { userId: claims.sub, locale };
  } catch {
    return null;
  }
}

export function mobileAppEmailUnsubscribeUrl(
  userId: string,
  locale?: string | null,
): string {
  const url = new URL("/api/email/mobile-app/unsubscribe", serverOrigin());
  url.searchParams.set("token", createMobileAppEmailUnsubscribeToken(userId, locale));
  return url.toString();
}
