// Exercise the actual production builds. All outside origins are intercepted.
// From packages/web: pnpm build && node scripts/check-privacy-mode.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../dist", import.meta.url));
let enabled = false;
const app = createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path === "/api/privacy-mode") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ enabled }));
  }
  if (path.startsWith("/api/")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ tickets: [], next_cursor: null, has_more: false, unread_total: 0 }));
  }
  const file = resolve(root, "." + path + (path.endsWith("/") ? "index.html" : ""));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
    res.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${app.address().port}`;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.RAFT_CHROMIUM_EXECUTABLE || undefined });
  for (enabled of [false, true]) {
    const context = await browser.newContext();
    try {
      const external = [], api = [];
      await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) {
          if (url.pathname.startsWith("/api/")) api.push(url.pathname);
          return route.continue();
        }
        external.push(url.hostname);
        return route.fulfill({ contentType: "text/css", body: "" });
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", e => errors.push(e.message));
      page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });
      await page.goto(origin);
      await page.locator("#login-email").waitFor({ timeout: 12_000 }).catch(error => {
        throw new Error(`Portal failed to start (privacy=${enabled}): ${errors.join("; ")}`, { cause: error });
      });
      // Both upstream behavior and the opt-out must survive bundler preloads.
      await page.waitForLoadState("networkidle");
      if (enabled) {
        // Attempt a reporting POST and a tracking image from the compiled page.
        // The route handler above also catches requests that fail due to CORS.
        const blocked = await page.evaluate(async () => {
          const url = "https://slock-trace-upload.botiverse.dev/test-only";
          const report = fetch(url, { method: "POST", body: "fixture" }).then(() => false, () => true);
          const image = new Promise(resolve => {
            const img = new Image();
            img.onload = () => resolve(false);
            img.onerror = () => resolve(true);
            img.src = url;
          });
          return Promise.all([report, image]);
        });
        assert.deepEqual(blocked, [true, true]);
        assert.deepEqual(external, []);
      }
      else assert.ok(external.includes("fonts.googleapis.com"), "normal portal still loads its public fonts");
      assert.equal(api.filter(path => path === "/api/privacy-mode").length, 1);
      api.length = external.length = 0;
      await page.addInitScript(() => {
        window.RaftFeedback = { version: "raft-feedback-v1", session: {
          accountId: "fixture", sessionGeneration: 1, webViewGeneration: 1,
          accessToken: "fixture", apiOrigin: location.origin, clientKind: "android",
          clientVersion: "1", locale: "en", theme: "raft", mode: "light",
        }, emit() {} };
      });
      await page.goto(origin + "/feedback/");
      if (enabled) {
        await page.getByText("Feedback is disabled in privacy mode.", { exact: true }).waitFor();
        assert.deepEqual(api, ["/api/privacy-mode"]);
        assert.deepEqual(external, []);
      } else {
        await page.getByRole("button", { name: "New feedback", exact: true }).waitFor();
        assert.ok(api.includes("/api/product-feedback/tickets"));
      }
    } finally { await context.close(); }
  }
  console.log("One portal and feedback bundle passed with privacy mode off and on.");
} finally {
  await browser?.close();
  await new Promise(resolve => app.close(resolve));
}
