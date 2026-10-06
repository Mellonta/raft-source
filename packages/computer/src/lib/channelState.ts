// Raft Computer release channel STATE (RFC v0.8 contract v6 §6/§10/§11 /
// PR-E §2.1) — the pure parse/read/write core, extracted from channel.ts so
// the ComputerApi facade and the upgrade/service internals can consume it
// without importing the CLI presenter layer (import-cycle decycle R0/R2,
// #wg-raft-computer:18ab6541).
//
// Release channels (v6 §11 enum, extended by task #816):
//   `latest`  — production. Tracks staging→production release cuts (default
//               if no channel file present).
//   `alpha`   — staging-tracking. Updated continuously from staging branch.
//   `pinned:<semver>` — user-pinned exact version. NEVER auto-bumped.
//   `<named>` — a named release channel published for one feature branch
//               (task #816, e.g. `constructed-wake-context`). Lowercase
//               letters, digits and hyphens; maps 1:1 to the Hands channel of
//               the same slug. Reserved words that name other cohorts are
//               refused so a typo cannot silently select production.
//
// State storage: `~/.slock/computer/channel` (one-line text). Contract-mutable
// ONLY via `raft-computer channel set <name>`. Manual edit is undefined
// behavior (per v6 §10 invariant); the service reads the file as a
// cached invariant for its lifetime.
//
// Default: `latest` when file absent or unreadable. Reading the channel
// never throws — corrupt content falls back to default.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { channelPath } from "../paths";

export const DEFAULT_CHANNEL = "latest";
// Prerelease identifiers may contain hyphens (feature versions are
// <base>-<channel>.<n>, e.g. 1.0.33-constructed-wake-context.1).
export const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * A named (feature-branch) release channel slug, validated by `parseChannel`.
 * Branded so only the parser can produce one; every consumer that maps it to
 * a Hands channel does so from this type, never from a raw string.
 */
export type NamedReleaseChannel = string & { readonly __namedReleaseChannel: unique symbol };

export type Channel = "latest" | "alpha" | `pinned:${string}` | NamedReleaseChannel;

/** Lowercase slug: starts alphanumeric, hyphens allowed inside, 3–64 chars. */
export const NAMED_CHANNEL_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/**
 * Words that name other release cohorts or selectors. Refused as named
 * channels so `channel set main` cannot masquerade as a feature channel.
 */
export const RESERVED_CHANNEL_WORDS: ReadonlySet<string> = new Set([
  "main", "stable", "rc", "release", "staging", "production", "prod", "nightly", "preview", "pinned", "default",
]);

export function isNamedReleaseChannel(value: string): value is NamedReleaseChannel {
  return NAMED_CHANNEL_RE.test(value) && !RESERVED_CHANNEL_WORDS.has(value) && value !== "latest" && value !== "alpha";
}

/**
 * Validate a channel string against the enum above. Returns the canonical
 * channel (trimmed) when valid; null when invalid.
 */
export function parseChannel(raw: string): Channel | null {
  const v = raw.trim();
  if (v === "latest" || v === "alpha") return v;
  if (v.startsWith("pinned:")) {
    const semver = v.slice("pinned:".length);
    if (SEMVER_RE.test(semver)) return `pinned:${semver}` as Channel;
    return null;
  }
  if (isNamedReleaseChannel(v)) return v;
  return null;
}

/**
 * The Hands channel slug a Computer channel selects. `latest` is Hands `main`;
 * `alpha` and named channels map 1:1; a pinned selector is passed through so
 * the Hands updater resolves the exact version on `main`.
 */
export function toHandsChannelSlug(channel: Channel): string {
  return channel === "latest" ? "main" : channel;
}

/**
 * Read the persisted channel from `~/.slock/computer/channel`. Returns
 * the default `latest` when file is absent / unreadable / contains an
 * unrecognized value. Reading is intentionally lenient: a corrupt file
 * should not block CLI invocations.
 */
export async function readChannel(slockHome: string): Promise<Channel> {
  try {
    const raw = await readFile(channelPath(slockHome), "utf8");
    const parsed = parseChannel(raw);
    if (parsed !== null) return parsed;
  } catch {
    /* missing / unreadable → default */
  }
  return DEFAULT_CHANNEL;
}

/**
 * Write the channel value to `~/.slock/computer/channel`. Caller MUST
 * pass an already-validated value (use `parseChannel` first). The file
 * is created with mode 0600 to match other Computer-local state.
 */
export async function writeChannel(slockHome: string, channel: Channel): Promise<void> {
  const p = channelPath(slockHome);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, `${channel}\n`, { mode: 0o600 });
}
