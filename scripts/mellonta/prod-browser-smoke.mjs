// Exercise the real production bundle on an insecure remote-style HTTP origin.
// localhost is a secure context and would hide the original UUID boot crash.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const origin = process.env.RAFT_SMOKE_ORIGIN || "http://raft-http.test:8001";
const address = new URL(origin);
assert.equal(address.protocol, "http:");
assert.equal(address.hostname, "raft-http.test");
const accountFile = process.argv[2];
assert.ok(accountFile, "Pass the disposable CI account file from prod-smoke.py");
const account = JSON.parse(await readFile(accountFile, "utf8"));
const browser = await chromium.launch({
  executablePath: process.env.RAFT_CHROMIUM_EXECUTABLE || undefined,
  args: ["--host-resolver-rules=MAP raft-http.test 127.0.0.1", "--no-proxy-server"],
});
const errors = [];
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === origin && url.pathname.startsWith("/assets/") && response.status() >= 400) {
      errors.push(`Asset ${url.pathname}: HTTP ${response.status()}`);
    }
  });
  await page.addInitScript(() => {
    // Observe the real browser environment before any application scripts run.
    window.__initialCryptoContext = {
      secure: window.isSecureContext,
      randomUUID: typeof window.crypto.randomUUID,
    };
  });
  await page.goto(origin);
  await page.locator("#login-email").waitFor({ state: "visible" });
  assert.deepEqual(await page.evaluate(() => window.__initialCryptoContext), {
    secure: false, randomUUID: "undefined",
  });
  const uuids = await page.evaluate(() => [crypto.randomUUID(), crypto.randomUUID()]);
  for (const uuid of uuids) assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(uuids[0], uuids[1]);
  assert.deepEqual(errors, [], "The sign-in screen must render without JavaScript errors");
  await page.locator("#login-email").fill(account.email);
  await page.locator("#login-password").fill(account.password);
  const loginResponse = page.waitForResponse((response) => response.url() === origin + "/api/auth/login");
  await page.locator('form button[type="submit"]').click();
  assert.equal((await loginResponse).status(), 200, "Browser login must reach the same-origin API");
  // A fresh browser has no remembered workspace; select the CI-created one.
  await page.getByTestId("server-selector-option").filter({ hasText: "Deployment smoke" }).click();
  await page.getByTestId("sidebar-root").waitFor({ state: "visible" });
  await page.reload();
  await page.getByTestId("sidebar-root").waitFor({ state: "visible" });
  assert.deepEqual(errors, [], "Login and session restoration must not crash");
  console.log("Remote HTTP browser checks passed: UUID bootstrap, sign-in, workspace, and session restoration.");
} catch (error) {
  // Never print the account's credentials or response bodies.
  console.error("Browser errors:", errors);
  throw error;
} finally {
  await browser.close();
}
