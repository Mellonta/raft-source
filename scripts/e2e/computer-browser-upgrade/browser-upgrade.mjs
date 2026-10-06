#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const STAGING_API_ORIGIN = "https://api-aws-staging.botiverse.dev";
const STAGING_FRONTEND_ORIGIN = "https://raft-app-staging.botiverse.dev";

function failUsage(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

class BrowserRunFailure extends Error {
  constructor(category) {
    super(category);
    this.name = "BrowserRunFailure";
    this.category = category;
  }
}

function failureCategory(error) {
  if (error instanceof BrowserRunFailure) return error.category;
  if (error && typeof error === "object" && error.name === "TimeoutError") {
    return "browser_timeout";
  }
  return "browser_driver_failed";
}

const opts = {};
for (let i = 2; i < process.argv.length; i += 2) {
  opts[process.argv[i]] = process.argv[i + 1];
}

const sessionPath = opts["--session"];
const serverSlug = opts["--server-slug"];
const machineId = opts["--machine-id"];
const targetVersion = opts["--target-version"];
const mode = opts["--mode"] ?? "observe";
const outDir = resolve(opts["--out-dir"] ?? "artifacts/task809/browser-run");
const playwrightRoot = process.env.TASK809_PLAYWRIGHT_ROOT;

if (!sessionPath || !serverSlug || !machineId || !targetVersion || !playwrightRoot) {
  failUsage("usage: TASK809_PLAYWRIGHT_ROOT=/repo browser-upgrade.mjs --session FILE --server-slug SLUG --machine-id UUID --target-version SEMVER --mode observe|upgrade --out-dir DIR");
}
if (mode !== "observe" && mode !== "upgrade") failUsage("mode must be observe or upgrade");

const require = createRequire(import.meta.url);
const { chromium } = require(resolve(playwrightRoot, "node_modules/playwright"));
const session = JSON.parse(await readFile(sessionPath, "utf8"));
if (typeof session.accessToken !== "string" || typeof session.refreshToken !== "string"
  || session.origin !== STAGING_API_ORIGIN
  || session.frontendOrigin !== STAGING_FRONTEND_ORIGIN) {
  failUsage("session file is missing browser credentials or frontend origin");
}

await mkdir(outDir, { recursive: true });
const route = `${session.frontendOrigin}/s/${encodeURIComponent(serverSlug)}/computer/${encodeURIComponent(machineId)}`;
const receiptPath = resolve(outDir, `receipt-${mode}.json`);
const consoleIssueCounts = {
  resourceLoadFailed: 0,
  consoleError: 0,
  pageError: 0,
};
const receipt = {
  schema: "raft.task809.browser-upgrade.v1",
  observedAt: null,
  route,
  serverSlug,
  machineId,
  targetVersion,
  mode,
  setupGate: { visible: false, heading: null },
  upgradeButton: { count: null, text: null, title: null, enabled: null },
  action: null,
  consoleIssues: consoleIssueCounts,
  failure: null,
};

let browser = null;
let page = null;
let stage = "launch_browser";
let succeeded = false;

try {
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
    frontendOrigin: session.frontendOrigin,
  });

  page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (message.text().startsWith("Failed to load resource:")) {
      consoleIssueCounts.resourceLoadFailed += 1;
    } else {
      consoleIssueCounts.consoleError += 1;
    }
  });
  page.on("pageerror", () => {
    consoleIssueCounts.pageError += 1;
  });

  stage = "open_machine_route";
  await page.goto(route, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
  const expectedButtonTitle = `Upgrade to v${targetVersion}`;
  stage = "wait_for_machine_route";
  await Promise.any([
    page.locator('[data-testid="computer-service-actions"]').waitFor({ state: "visible", timeout: 60_000 }),
    page.getByRole("heading", { name: "Meet Cindy", exact: true }).waitFor({ state: "visible", timeout: 60_000 }),
    page.getByRole("heading", { name: "Connect a computer", exact: true }).waitFor({ state: "visible", timeout: 60_000 }),
  ]).catch(() => {
    throw new BrowserRunFailure("machine_route_not_ready");
  });
  await page.waitForTimeout(500);
  receipt.observedAt = new Date().toISOString();

  stage = "inspect_machine_route";
  const setupGateHeadings = ["Meet Cindy", "Connect a computer"];
  let setupGateHeading = null;
  for (const heading of setupGateHeadings) {
    if (await page.getByRole("heading", { name: heading, exact: true }).isVisible().catch(() => false)) {
      setupGateHeading = heading;
      break;
    }
  }
  receipt.setupGate = { visible: setupGateHeading !== null, heading: setupGateHeading };

  // Bind to the product's exact target-version control. A text substring such
  // as "Upgrade" can also match the machine row when the run-scoped machine
  // name contains that word.
  const upgradeButton = page.locator(`button[title=${JSON.stringify(expectedButtonTitle)}]`);
  const buttonCount = await upgradeButton.count();
  let button = null;
  if (buttonCount === 1) {
    button = upgradeButton;
    receipt.upgradeButton = {
      count: buttonCount,
      text: (await button.innerText()).trim(),
      title: await button.getAttribute("title"),
      enabled: await button.isEnabled(),
    };
  } else {
    receipt.upgradeButton.count = buttonCount;
  }

  await page.screenshot({ path: resolve(outDir, `before-${mode}.png`), fullPage: true });

  if (mode === "upgrade") {
    stage = "validate_upgrade_gate";
    if (setupGateHeading !== null) {
      throw new BrowserRunFailure("server_setup_gate_blocked");
    }
    if (buttonCount !== 1 || !button || receipt.upgradeButton.enabled !== true) {
      throw new BrowserRunFailure("upgrade_button_gate_failed");
    }
    if (!receipt.upgradeButton.text?.includes(`v${targetVersion}`)
      || receipt.upgradeButton.title !== expectedButtonTitle) {
      throw new BrowserRunFailure("upgrade_button_target_mismatch");
    }

    stage = "click_upgrade";
    receipt.actionStartedAt = new Date().toISOString();
    const [response] = await Promise.all([
      page.waitForResponse((candidate) =>
        candidate.request().method() === "POST"
          && candidate.url().endsWith(`/machines/${machineId}/computer/upgrade`),
      { timeout: 30_000 }),
      button.click(),
    ]);
    const responseBody = await response.json().catch(() => null);
    const responseTargetVersion = typeof responseBody?.targetVersion === "string"
      ? responseBody.targetVersion
      : null;
    const responseTargetFailure = responseTargetVersion === null
      ? "upgrade_response_target_missing"
      : responseTargetVersion !== targetVersion
        ? "upgrade_response_target_mismatch"
        : null;
    receipt.action = {
      observedAt: new Date().toISOString(),
      status: response.status(),
      requestId: responseBody?.requestId ?? null,
      operationId: responseBody?.operationId ?? null,
      queued: responseBody?.queued === true,
      targetVersion: responseTargetVersion,
      expectedTargetVersion: targetVersion,
    };
    // Persist the causal operation identity before the long reconnect wait so
    // an interrupted driver still leaves a durable binding for diagnosis and
    // cleanup. The finally block rewrites the complete terminal receipt.
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    if (!response.ok()) throw new BrowserRunFailure("upgrade_request_failed");
    if (responseTargetFailure) throw new BrowserRunFailure(responseTargetFailure);

    stage = "wait_for_upgrade_completion";
    const success = page.getByText(`Upgraded to v${targetVersion}`, { exact: false });
    await success.waitFor({ state: "visible", timeout: 10 * 60_000 });
    receipt.completedAt = new Date().toISOString();
    receipt.successText = (await success.innerText()).trim();
    await page.screenshot({ path: resolve(outDir, "after-upgrade.png"), fullPage: true });
  }

  succeeded = true;
} catch (error) {
  receipt.failedAt = new Date().toISOString();
  receipt.failure = {
    category: failureCategory(error),
    stage,
  };
  if (page) {
    try {
      await page.screenshot({ path: resolve(outDir, `failure-${mode}.png`), fullPage: true });
      receipt.failure.screenshot = `failure-${mode}.png`;
    } catch {
      receipt.failure.screenshot = null;
    }
  }
} finally {
  let receiptWritten = false;
  try {
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    receiptWritten = true;
  } catch {
    process.stderr.write("browser receipt write failed\n");
  }
  if (browser) {
    try {
      await browser.close();
    } catch {
      // The durable receipt above is authoritative; browser close is best-effort.
    }
  }
  if (!receiptWritten) process.exitCode = 1;
}

if (!succeeded) {
  process.stderr.write(`browser run failed: ${receipt.failure?.category ?? "unknown"} stage=${receipt.failure?.stage ?? "unknown"}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
