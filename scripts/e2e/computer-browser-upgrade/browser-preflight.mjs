#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const STAGING_API_ORIGIN = "https://api-aws-staging.botiverse.dev";
const STAGING_FRONTEND_ORIGIN = "https://raft-app-staging.botiverse.dev";

function failUsage(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const opts = {};
for (let index = 2; index < process.argv.length; index += 2) {
  opts[process.argv[index]] = process.argv[index + 1];
}

const sessionPath = opts["--session"];
const serverSlug = opts["--server-slug"];
const expectedServerId = opts["--server-id"];
const outDir = resolve(opts["--out-dir"] ?? "artifacts/task809/browser-preflight");
const playwrightRoot = process.env.TASK809_PLAYWRIGHT_ROOT;

if (!sessionPath || !serverSlug || !expectedServerId || !playwrightRoot) {
  failUsage("usage: TASK809_PLAYWRIGHT_ROOT=/repo browser-preflight.mjs --session FILE --server-slug SLUG --server-id UUID --out-dir DIR");
}

const require = createRequire(import.meta.url);
const { chromium } = require(resolve(playwrightRoot, "node_modules/playwright"));
const session = JSON.parse(await readFile(sessionPath, "utf8"));
if (session.origin !== STAGING_API_ORIGIN
  || session.frontendOrigin !== STAGING_FRONTEND_ORIGIN
  || typeof session.accessToken !== "string"
  || typeof session.refreshToken !== "string") {
  failUsage("session file is missing staging browser credentials");
}

await mkdir(outDir, { recursive: true });
const route = `${STAGING_FRONTEND_ORIGIN}/s/${encodeURIComponent(serverSlug)}/computers`;
const receiptPath = resolve(outDir, "preflight-receipt.json");
const receipt = {
  schema: "raft.task809.browser-preflight.v1",
  observedAt: null,
  route,
  expectedServerId,
  serverSlug,
  normalComputersSurface: false,
  serverIdentityMatched: false,
  setupGate: { visible: null, heading: null },
  setupResumeBarVisible: null,
  consoleIssues: { resourceLoadFailed: 0, consoleError: 0, pageError: 0 },
  failure: null,
};

let browser = null;
let page = null;
let passed = false;
let stage = "launch_browser";

try {
  stage = "validate_server_identity";
  const serverResponse = await fetch(`${STAGING_API_ORIGIN}/api/servers`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  if (!serverResponse.ok) throw new Error("server_identity_unavailable");
  const serverBody = await serverResponse.json();
  const servers = Array.isArray(serverBody)
    ? serverBody
    : Array.isArray(serverBody?.servers)
      ? serverBody.servers
      : Array.isArray(serverBody?.data)
        ? serverBody.data
        : null;
  if (!servers) throw new Error("server_identity_shape_invalid");
  receipt.serverIdentityMatched = servers.some((server) =>
    server?.id === expectedServerId && server?.slug === serverSlug,
  );
  if (!receipt.serverIdentityMatched) throw new Error("server_identity_mismatch");

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(({ accessToken, refreshToken, slug, frontendOrigin }) => {
    if (location.origin !== frontendOrigin) return;
    localStorage.setItem("slock_access_token", accessToken);
    localStorage.setItem("slock_refresh_token", refreshToken);
    localStorage.setItem("slock_last_server_slug", slug);
  }, {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    slug: serverSlug,
    frontendOrigin: STAGING_FRONTEND_ORIGIN,
  });

  page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (message.text().startsWith("Failed to load resource:")) {
      receipt.consoleIssues.resourceLoadFailed += 1;
    } else {
      receipt.consoleIssues.consoleError += 1;
    }
  });
  page.on("pageerror", () => { receipt.consoleIssues.pageError += 1; });

  stage = "open_computers_route";
  await page.goto(route, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});

  stage = "wait_for_surface";
  await Promise.any([
    page.getByTestId("left-rail-tab-computers").waitFor({ state: "visible", timeout: 60_000 }),
    page.getByRole("heading", { name: "Meet Cindy", exact: true }).waitFor({ state: "visible", timeout: 60_000 }),
    page.getByRole("heading", { name: "Connect a computer", exact: true }).waitFor({ state: "visible", timeout: 60_000 }),
  ]);
  await page.waitForTimeout(500);
  receipt.observedAt = new Date().toISOString();

  stage = "inspect_surface";
  const setupHeadings = ["Meet Cindy", "Connect a computer"];
  let visibleHeading = null;
  for (const heading of setupHeadings) {
    if (await page.getByRole("heading", { name: heading, exact: true }).isVisible().catch(() => false)) {
      visibleHeading = heading;
      break;
    }
  }
  receipt.setupGate = { visible: visibleHeading !== null, heading: visibleHeading };
  receipt.setupResumeBarVisible = await page.getByTestId("server-setup-resume-bar")
    .isVisible()
    .catch(() => false);
  receipt.normalComputersSurface = await page.getByTestId("left-rail-tab-computers")
    .isVisible()
    .catch(() => false);
  await page.screenshot({ path: resolve(outDir, "computers-preflight.png"), fullPage: true });

  if (!receipt.normalComputersSurface
    || !receipt.serverIdentityMatched
    || receipt.setupGate.visible
    || receipt.setupResumeBarVisible) {
    throw new Error("computers_surface_blocked");
  }
  passed = true;
} catch (error) {
  receipt.failure = {
    category: error instanceof Error && [
      "computers_surface_blocked",
      "server_identity_unavailable",
      "server_identity_shape_invalid",
      "server_identity_mismatch",
    ].includes(error.message) ? error.message : "browser_preflight_failed",
    stage,
  };
  if (page) {
    try {
      await page.screenshot({ path: resolve(outDir, "computers-preflight-failure.png"), fullPage: true });
    } catch {
      // The fixed receipt still records the failing stage.
    }
  }
} finally {
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  if (browser) await browser.close().catch(() => {});
}

if (!passed) {
  process.stderr.write(`browser preflight failed: ${receipt.failure?.category ?? "unknown"}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
