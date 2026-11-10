import { privacyModeEnabled } from "@botiverse/raft-shared/src/privacyMode";
import { Router } from "express";
import { mobileDownloadChooserUrl } from "./mobileDownload";

/**
 * Public redirect to the current Raft Desktop build.
 *
 * `GET /api/desktop-download?target=mac|mac-arm64|mac-x64|linux-appimage|linux-deb|windows`
 * `GET /api/desktop-download/platforms` — what the Latest release offers (JSON)
 *
 * The desktop twin of `/api/mobile-download`, and public for the same reason:
 * the `/download` page is anonymous. The artifacts are the public releases of
 * botiverse/desktop-beta.
 *
 * **The version comes from the desktop's own auto-update feed** — the
 * `latest-mac.yml` / `latest-linux.yml` / `latest.yml` that electron-updater
 * reads from the Latest desktop-beta release. So a download from the web and an
 * in-app update can never disagree about which build is current, and a release
 * needs no extra step to reach this route: marking it Latest is the switch.
 * The asset filenames carry the version (`Raft-Desktop-0.1.42-arm64.dmg`), so
 * there is no stable per-file URL to link to directly; this route is the stable
 * address.
 *
 * **An explicit target is required; the UA is never consulted.** An iPad
 * reports a User-Agent byte-identical to a Mac (see `platformFromUserAgent` in
 * mobileDownload.ts), so a UA guess here would hand an iPad a .dmg. Only the
 * browser can tell them apart (`maxTouchPoints`), so the web decides the target
 * and anything without one goes to the `/download` chooser.
 */

const RELEASES = process.env.RAFT_DESKTOP_RELEASES_BASE_URL ?? "https://github.com/botiverse/desktop-beta/releases";

type Feed = "latest-mac.yml" | "latest-linux.yml" | "latest.yml";

/**
 * Which feed lists the target, and which listed file it is.
 *
 * `mac` prefers a universal build and falls back to Apple silicon: universal
 * installs on every Mac, and Apple silicon is what a Mac without a universal
 * build most likely is. The Intel build stays reachable as `mac-x64`.
 */
const TARGETS = {
  mac: { feed: "latest-mac.yml", files: [/-universal\.dmg$/, /-arm64\.dmg$/] },
  "mac-arm64": { feed: "latest-mac.yml", files: [/-universal\.dmg$/, /-arm64\.dmg$/] },
  "mac-x64": { feed: "latest-mac.yml", files: [/-universal\.dmg$/, /-x64\.dmg$/] },
  "linux-appimage": { feed: "latest-linux.yml", files: [/-x86_64\.AppImage$/] },
  "linux-deb": { feed: "latest-linux.yml", files: [/-amd64\.deb$/] },
  windows: { feed: "latest.yml", files: [/-x64\.exe$/, /\.exe$/] },
} as const satisfies Record<string, { feed: Feed; files: readonly RegExp[] }>;

export type DesktopTarget = keyof typeof TARGETS;

export function isDesktopTarget(value: unknown): value is DesktopTarget {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(TARGETS, value);
}

/**
 * `version` and the `files[].url` entries of an electron-builder update feed.
 *
 * The feed is a fixed, flat shape that electron-builder writes, so this reads
 * just those two keys rather than pulling a YAML parser into the server.
 * Anything it does not recognise is ignored; a feed without a version reads as
 * no feed at all.
 */
export function parseUpdateFeed(text: string): { version: string; files: string[] } | null {
  const version = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text)?.[1];
  // The version becomes a path segment of the redirect (`/download/v<version>/`),
  // so it must be a plain semver: a `../` or `?` here would point the redirect
  // at another github.com path. Whoever can upload to desktop-beta is trusted,
  // but the redirect target should not depend on that.
  if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return null;
  const files = [...text.matchAll(/^\s*-\s*url:\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map((m) => m[1]);
  return { version, files };
}

type FeedRead =
  | { outcome: "feed"; version: string; files: string[] }
  | { outcome: "no_feed" }
  | { outcome: "upstream_error"; detail: string };

type Deps = {
  fetch: typeof fetch;
  releasesBase?: string;
  /** Shared by the router; tests pass none so each starts cold. */
  cache?: Map<string, { at: number; read: FeedRead }>;
  now?: () => number;
};

/** How long a feed read is reused. A new Latest release reaches people within a minute. */
const FEED_TTL_MS = 60_000;
/**
 * A failure is reused briefly too: while GitHub is down, every About page open
 * would otherwise make the server wait out the timeout three times over.
 */
const FEED_ERROR_TTL_MS = 10_000;
/** GitHub normally answers in well under a second; never hold a download click for minutes. */
const FEED_TIMEOUT_MS = 10_000;

async function readFeed(feed: Feed, deps: Deps): Promise<FeedRead> {
  if (privacyModeEnabled()) return { outcome: "no_feed" };
  const base = (deps.releasesBase ?? RELEASES).replace(/\/$/, "");
  const key = `${base}/${feed}`;
  const now = (deps.now ?? Date.now)();
  const hit = deps.cache?.get(key);
  if (hit && now - hit.at < (hit.read.outcome === "upstream_error" ? FEED_ERROR_TTL_MS : FEED_TTL_MS)) return hit.read;
  const read = await fetchFeed(`${base}/latest/download/${feed}`, feed, deps.fetch);
  deps.cache?.set(key, { at: now, read });
  return read;
}

async function fetchFeed(url: string, feed: Feed, fetchImpl: typeof fetch): Promise<FeedRead> {
  try {
    const response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });
    // No such feed on the Latest release: that platform has not shipped (Windows
    // before its first release). A legal state, not a fault.
    if (response.status === 404) return { outcome: "no_feed" };
    if (!response.ok) return { outcome: "upstream_error", detail: `HTTP ${response.status}` };
    const parsed = parseUpdateFeed(await response.text());
    if (!parsed) return { outcome: "upstream_error", detail: `${feed} has no valid version` };
    return { outcome: "feed", ...parsed };
  } catch (cause) {
    return { outcome: "upstream_error", detail: `request failed: ${String(cause)}` };
  }
}

function pick(files: string[], patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const name = files.find((file) => pattern.test(file) && !file.includes("/"));
    if (name) return name;
  }
  return null;
}

export type DesktopLookup =
  | { outcome: "asset"; url: string; version: string }
  | { outcome: "no_build" }
  | { outcome: "upstream_error"; detail: string };

export async function lookupDesktopAsset(target: DesktopTarget, deps: Deps): Promise<DesktopLookup> {
  const base = (deps.releasesBase ?? RELEASES).replace(/\/$/, "");
  const { feed, files } = TARGETS[target];
  const read = await readFeed(feed, deps);
  if (read.outcome === "no_feed") return { outcome: "no_build" };
  if (read.outcome === "upstream_error") return read;
  const name = pick(read.files, files);
  return name
    ? { outcome: "asset", url: `${base}/download/v${read.version}/${encodeURIComponent(name)}`, version: read.version }
    : { outcome: "no_build" };
}

export type PlatformStatus = { status: "available"; version: string } | { status: "none" } | { status: "unknown" };
export type DesktopPlatforms = {
  mac: PlatformStatus & { universal?: boolean };
  linux: PlatformStatus;
  windows: PlatformStatus;
};

/**
 * What the Latest release offers, for the web to render from — so shipping a
 * platform (the first Windows build, a universal Mac build) is a release, not a
 * web code edit. `unknown` means GitHub did not answer; the web then falls back
 * to its defaults rather than hiding a platform that probably exists.
 */
export async function lookupDesktopPlatforms(deps: Deps): Promise<DesktopPlatforms> {
  const status = (read: FeedRead, installers: readonly RegExp[]): PlatformStatus => {
    if (read.outcome === "upstream_error") return { status: "unknown" };
    if (read.outcome === "no_feed" || !pick(read.files, installers)) return { status: "none" };
    return { status: "available", version: read.version };
  };
  const [mac, linux, windows] = await Promise.all([
    readFeed("latest-mac.yml", deps),
    readFeed("latest-linux.yml", deps),
    readFeed("latest.yml", deps),
  ]);
  const macStatus = status(mac, TARGETS.mac.files);
  return {
    mac: macStatus.status === "available" && mac.outcome === "feed"
      ? { ...macStatus, universal: pick(mac.files, [/-universal\.dmg$/]) !== null }
      : macStatus,
    linux: status(linux, TARGETS["linux-appimage"].files),
    windows: status(windows, TARGETS.windows.files),
  };
}

const feedCache = new Map<string, { at: number; read: FeedRead }>();

export const desktopDownloadRouter: Router = Router();

desktopDownloadRouter.get("/platforms", async (_req, res) => {
  const platforms = await lookupDesktopPlatforms({ fetch, cache: feedCache });
  res.setHeader("Cache-Control", "public, max-age=60");
  res.json(platforms);
});

desktopDownloadRouter.get("/", async (req, res) => {
  if (privacyModeEnabled()) {
    res.status(404).json({ error: "Upstream downloads are disabled in privacy mode" });
    return;
  }
  const target = req.query.target;
  if (!isDesktopTarget(target)) {
    res.setHeader("Cache-Control", "private, max-age=300");
    res.redirect(302, mobileDownloadChooserUrl());
    return;
  }
  const result = await lookupDesktopAsset(target, { fetch, cache: feedCache });
  if (result.outcome === "asset") {
    // Short: a new Latest release should reach people within minutes.
    res.setHeader("Cache-Control", "private, max-age=300");
    res.redirect(302, result.url);
    return;
  }
  // The links are downloads opened in the same tab, so a JSON error body would
  // be a dead page. Hand the person the Latest release page instead: every
  // build that exists is there, and it is the honest fallback either way.
  if (result.outcome === "upstream_error") {
    console.error("[desktop-download] upstream error", { target, detail: result.detail });
  }
  res.setHeader("Cache-Control", "no-store");
  res.redirect(302, `${RELEASES.replace(/\/$/, "")}/latest`);
});
