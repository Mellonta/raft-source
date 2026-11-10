import { assertPrivacyServiceUrl, privacyModeEnabled } from "@botiverse/raft-shared/src/privacyMode";
export const DEFAULT_SLOCK_SERVER_URL = "https://api.raft.build";
export const LEGACY_PRODUCTION_SERVER_URL = "https://api.slock.ai";
export const SLOCK_SERVER_URL_ENV = "SLOCK_SERVER_URL";
export const RAFT_SERVER_URL_ENV = "RAFT_SERVER_URL";

/** Never place workspace identifiers on hosted links in private mode. */
export function computerPortalOrigin(serverUrl?: string): string {
  if (!privacyModeEnabled()) return "https://app.raft.build";
  if (!serverUrl) return "";
  assertPrivacyServiceUrl(serverUrl);
  return new URL(serverUrl).origin;
}

export function canonicalizeServerUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim().replace(/\/+$/, "");
  assertPrivacyServiceUrl(trimmed);
  return trimmed === LEGACY_PRODUCTION_SERVER_URL ? DEFAULT_SLOCK_SERVER_URL : trimmed;
}

export function resolveServerUrl(...candidates: Array<string | undefined | null>): string {
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value) return canonicalizeServerUrl(value);
  }
  if (privacyModeEnabled()) throw new Error("RAFT_PRIVACY_MODE requires --server-url or RAFT_SERVER_URL.");
  return DEFAULT_SLOCK_SERVER_URL;
}

export function resolveServerUrlEnv(
  env: Partial<Record<typeof SLOCK_SERVER_URL_ENV | typeof RAFT_SERVER_URL_ENV, string | undefined>> = process.env,
): string | undefined {
  return env[SLOCK_SERVER_URL_ENV] ?? env[RAFT_SERVER_URL_ENV];
}
