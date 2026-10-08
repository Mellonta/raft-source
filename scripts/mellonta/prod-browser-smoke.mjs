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
  // The application must boot without the previous standalone crypto patch.
  await page.route("**/browser-crypto-bootstrap.js", (route) => route.abort());
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) {
      errors.push(`Unexpected external browser request: ${url.origin}${url.pathname}`);
    }
    if (/\/(product-events|scope-attestation|prompt-events)(\/|$)/.test(url.pathname)) {
      errors.push(`Unexpected telemetry request: ${url.pathname}`);
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === origin && url.pathname.startsWith("/assets/") && response.status() >= 400) {
      errors.push(`Asset ${url.pathname}: HTTP ${response.status()}`);
    }
  });
  await page.addInitScript(() => {
    // Observe the real browser environment before any application scripts run.
    window.__initialCrypto = window.crypto;
    window.__initialGetRandomValues = window.crypto.getRandomValues;
    window.__initialCryptoContext = {
      secure: window.isSecureContext,
      randomUUID: typeof window.crypto.randomUUID,
    };
  });
  await page.goto(origin);
  await page.locator("#login-email").waitFor({ state: "visible" });
  assert.equal(await page.locator('script[src*="browser-crypto-bootstrap.js"]').count(), 0);
  assert.deepEqual(await page.evaluate(() => window.__initialCryptoContext), {
    secure: false, randomUUID: "undefined",
  });
  async function assertUnmodifiedCrypto() {
    assert.deepEqual(await page.evaluate(() => ({
      sameObject: window.crypto === window.__initialCrypto,
      sameEntropySource: window.crypto.getRandomValues === window.__initialGetRandomValues,
      randomUUID: typeof window.crypto.randomUUID,
    })), { sameObject: true, sameEntropySource: true, randomUUID: "undefined" });
  }
  await assertUnmodifiedCrypto();
  assert.deepEqual(errors, [], "The sign-in screen must render without JavaScript errors");
  await page.locator("#login-email").fill(account.email);
  await page.locator("#login-password").fill(account.password);
  const loginResponse = page.waitForResponse((response) => response.url() === origin + "/api/auth/login");
  await page.locator('form button[type="submit"]').click();
  const login = await loginResponse;
  assert.equal(login.status(), 200, "Browser login must reach the same-origin API");
  const headers = {
    Authorization: `Bearer ${(await login.json()).accessToken}`,
    "X-Server-Id": account.workspace,
  };
  // Complete the disposable fixture's onboarding so it cannot cover the chat.
  const onboarding = await page.request.patch(`${origin}/api/servers/${account.workspace}/onboarding-settings`, {
    headers, data: {
      setupModalReminderOptOut: true, dismissedAddComputerStep: true,
      dismissedCreateAgentStep: true, dismissedInviteStep: true,
      dismissedCommunityStep: true, dismissedNotificationStep: true,
    },
  });
  assert.ok(onboarding.ok(), `Onboarding fixture: HTTP ${onboarding.status()}`);
  // A fresh browser has no remembered workspace; select the CI-created one.
  await page.getByTestId("server-selector-option").filter({ hasText: "Deployment smoke" }).click();
  await page.getByTestId("sidebar-root").waitFor({ state: "visible" });
  await assertUnmodifiedCrypto();
  const channelResponse = await page.request.post(`${origin}/api/channels`, {
    headers, data: { name: `http-smoke-${Date.now()}` },
  });
  assert.ok(channelResponse.ok(), `Create channel: HTTP ${channelResponse.status()}`);
  const channel = await channelResponse.json();
  const workspacePath = new URL(page.url()).pathname.match(/^\/s\/[^/]+/)[0];
  await page.goto(`${origin}${workspacePath}/channel/${channel.id}`);
  const composer = page.getByPlaceholder(`Message #${channel.name}`);
  await composer.fill("HTTP production message 🛶");
  const sentResponse = page.waitForResponse((response) => response.url() === `${origin}/api/v2/messages` && response.request().method() === "POST");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const sent = await sentResponse;
  assert.ok(sent.ok(), `Send message: HTTP ${sent.status()}`);
  const sentMessage = page.getByTestId("message-scroller").getByText("HTTP production message 🛶", { exact: true });
  await sentMessage.waitFor({ state: "visible" });
  // Copy through the application's context menu and paste into its composer.
  // This verifies the HTTP fallback at a real callsite, with no Clipboard API.
  await sentMessage.click({ button: "right" });
  await page.getByText("Copy Markdown", { exact: true }).click();
  await composer.focus();
  await composer.press("ControlOrMeta+V");
  assert.equal(await composer.inputValue(), "HTTP production message 🛶");
  await composer.fill("");
  const incoming = await page.request.post(`${origin}/api/v2/messages`, {
    headers, data: { channelId: channel.id, content: "HTTP realtime arrival" },
  });
  assert.ok(incoming.ok(), `Incoming message: HTTP ${incoming.status()}`);
  await page.getByTestId("message-scroller").getByText("HTTP realtime arrival", { exact: true }).waitFor({ state: "visible" });
  await page.reload();
  await page.getByTestId("sidebar-root").waitFor({ state: "visible" });
  await page.getByTestId("message-scroller").getByText("HTTP production message 🛶", { exact: true }).waitFor({ state: "visible" });
  await page.getByTestId("message-scroller").getByText("HTTP realtime arrival", { exact: true }).waitFor({ state: "visible" });
  await assertUnmodifiedCrypto();
  assert.deepEqual(errors, [], "Login and session restoration must not crash");
  console.log("Remote HTTP browser checks passed: sign-in, workspace, sending, real copy/paste, realtime delivery, and persistence after reload; no crypto mutation or telemetry.");
} catch (error) {
  // Never print the account's credentials or response bodies.
  console.error("Browser errors:", errors);
  throw error;
} finally {
  await browser.close();
}
