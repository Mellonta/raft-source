// Exercise production on a LAN-style HTTP origin explicitly trusted by Chrome.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const origin = process.env.RAFT_SMOKE_ORIGIN || "http://raft-http.test:8001";
const address = new URL(origin);
assert.equal(address.protocol, "http:");
assert.equal(address.hostname, "raft-http.test");
// Playwright's Node-side fixture requests use the loopback listener. The
// browser itself resolves the portal hostname via Chromium.
const fixtureUrl = new URL(origin);
fixtureUrl.hostname = "127.0.0.1";
const accountFile = process.argv[2];
assert.ok(accountFile, "Pass the disposable CI account file from prod-smoke.py");
const account = JSON.parse(await readFile(accountFile, "utf8"));
const browser = await chromium.launch({
  executablePath: process.env.RAFT_CHROMIUM_EXECUTABLE || undefined,
  args: [
    "--host-resolver-rules=MAP raft-http.test 127.0.0.1", "--no-proxy-server",
    `--unsafely-treat-insecure-origin-as-secure=${address.origin}`,
  ],
});
const errors = [];
const mutations = [];
let page;
try {
  page = await browser.newPage();
  page.setDefaultTimeout(30_000);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) {
      errors.push(`Unexpected external browser request: ${url.origin}${url.pathname}`);
    }
    if (/\/(product-events|public-visits|product-feedback|scope-attestation|prompt-events)(\/|$)/.test(url.pathname)) {
      errors.push(`Unexpected telemetry request: ${url.pathname}`);
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === origin && response.request().method() === "POST") {
      mutations.push(`${url.pathname}: ${response.status()}`);
    }
    if (url.origin === origin && url.pathname.startsWith("/assets/") && response.status() >= 400) {
      errors.push(`Asset ${url.pathname}: HTTP ${response.status()}`);
    }
  });
  await page.goto(origin + "/feedback/");
  assert.equal(await page.evaluate(() => window.isSecureContext), true, "Chrome must trust the exact portal origin");
  assert.match(await page.evaluate(() => crypto.randomUUID()), /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
  const digest = await page.evaluate(async () => {
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("abc")));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  });
  assert.equal(digest, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  await page.getByText("Feedback is disabled in privacy mode.", { exact: true }).waitFor();
  await page.goto(origin);
  await page.locator("#login-email").waitFor({ state: "visible" });
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
  const onboarding = await page.request.get(`${fixtureUrl.origin}/api/servers/${account.workspace}/setup-projection`, { headers });
  assert.ok(onboarding.ok(), `Onboarding fixture: HTTP ${onboarding.status()}`);
  assert.equal((await onboarding.json()).blocksChat, false, "CI must seed completed onboarding before exercising chat");
  // A fresh browser has no remembered workspace; select the CI-created one.
  await page.getByTestId("server-selector-option").filter({ hasText: "Deployment smoke" }).click();
  await page.getByTestId("sidebar-root").waitFor({ state: "visible" });
  const channelResponse = await page.request.post(`${fixtureUrl.origin}/api/channels`, {
    headers, data: { name: `http-smoke-${Date.now()}` },
  });
  assert.ok(channelResponse.ok(), `Create channel: HTTP ${channelResponse.status()}`);
  const channel = await channelResponse.json();
  const workspacePath = new URL(page.url()).pathname.match(/^\/s\/[^/]+/)[0];
  await page.goto(`${origin}${workspacePath}/channel/${channel.id}`);
  const composer = page.getByPlaceholder(`Message #${channel.name}`);
  await composer.fill("HTTP production message 🛶");
  const [sent] = await Promise.all([
    page.waitForResponse((response) => response.url() === `${origin}/api/v2/messages` && response.request().method() === "POST"),
    page.getByRole("button", { name: "Send", exact: true }).click({ timeout: 10_000 }),
  ]);
  assert.ok(sent.ok(), `Send message: HTTP ${sent.status()}`);
  const sentMessage = page.getByTestId("message-scroller").getByText("HTTP production message 🛶", { exact: true });
  await sentMessage.waitFor({ state: "visible" });
  // Copy through the application's context menu and paste into its composer.
  await sentMessage.click({ button: "right" });
  await page.getByText("Copy Markdown", { exact: true }).click();
  // The app dismisses the menu after its async clipboard write resolves.
  await page.getByText("Copy Markdown", { exact: true }).waitFor({ state: "hidden" });
  await composer.focus();
  await composer.press("ControlOrMeta+V");
  await page.waitForFunction(() => document.activeElement?.value === "HTTP production message 🛶");
  await composer.fill("");
  const incoming = await page.request.post(`${fixtureUrl.origin}/api/v2/messages`, {
    headers, data: { channelId: channel.id, content: "HTTP realtime arrival" },
  });
  assert.ok(incoming.ok(), `Incoming message: HTTP ${incoming.status()}`);
  await page.getByTestId("message-scroller").getByText("HTTP realtime arrival", { exact: true }).waitFor({ state: "visible" });
  await page.reload();
  await page.getByTestId("sidebar-root").waitFor({ state: "visible" });
  await page.getByTestId("message-scroller").getByText("HTTP production message 🛶", { exact: true }).waitFor({ state: "visible" });
  await page.getByTestId("message-scroller").getByText("HTTP realtime arrival", { exact: true }).waitFor({ state: "visible" });
  assert.deepEqual(errors, [], "Login and session restoration must not crash");
  console.log("Chrome trusted-origin checks passed for native crypto, sign-in, messaging, copy/paste, and persistence after reload.");
} catch (error) {
  // Never print the account's credentials or response bodies.
  console.error("Browser errors:", errors);
  console.error("POST responses:", mutations);
  if (page && !page.isClosed()) {
    console.error("Visible controls:", await page.locator('button:visible, [role="dialog"]:visible, [role="alert"]:visible').evaluateAll((elements) => elements.map((element) => ({
      tag: element.tagName, role: element.getAttribute("role"),
      label: element.getAttribute("aria-label"),
      text: element.tagName === "BUTTON" ? element.textContent?.slice(0, 80) : null,
      testId: element.getAttribute("data-testid"), disabled: element.hasAttribute("disabled"),
    }))).catch(() => "Page unavailable"));
  }
  throw error;
} finally {
  await browser.close();
}
