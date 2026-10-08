// Exercise application helpers in real Chrome on HTTP, with native capabilities
// left untouched. The fixture is bundled separately and is never shipped.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = fileURLToPath(new URL("../../packages/web/", import.meta.url));
const { build } = createRequire(`${webRoot}package.json`)("esbuild");
const { outputFiles } = await build({
  stdin: {
    resolveDir: webRoot,
    contents: `
      import { copyTextToClipboard } from './src/utils/clipboard';
      import { providerProbeRequestDigest } from '../shared/src/providerProbes';
      import { randomUuid } from '../shared/src/randomUuid';
      window.runProbe = async (payload) => ({
        digest: await providerProbeRequestDigest(payload), id: randomUuid(),
      });
      document.querySelector('button').onclick = () => {
        copyTextToClipboard('raft-computer start\\n中文').then(() => {
          document.querySelector('output').textContent = 'Copied';
        }).catch(error => { document.querySelector('output').textContent = error.message; });
      };
    `,
  },
  bundle: true, platform: "browser", format: "esm", write: false,
});
const server = createServer((req, res) => {
  res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : "text/html; charset=utf-8");
  res.end(req.url === "/fixture.js" ? outputFiles[0].contents : `
    <dialog open><button>Copy command</button><output></output></dialog>
    <textarea aria-label="Paste here"></textarea><script type="module" src="/fixture.js"></script>
  `);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.RAFT_CHROMIUM_EXECUTABLE || undefined,
    args: ["--host-resolver-rules=MAP raft-http.test 127.0.0.1", "--no-proxy-server"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://raft-http.test:${server.address().port}`);
  assert.deepEqual(await page.evaluate(() => ({
    secure: isSecureContext, uuid: typeof crypto.randomUUID,
    subtle: typeof crypto.subtle, clipboard: typeof navigator.clipboard,
  })), { secure: false, uuid: "undefined", subtle: "undefined", clipboard: "undefined" });
  const payload = { connectionId: "connection", computerId: "computer", runtime: "builtin", model: "模型", probeKind: "canary" };
  const result = await page.evaluate((input) => window.runProbe(input), payload);
  const canonical = JSON.stringify(Object.fromEntries(Object.entries({ ...payload, schema: "provider-probe-request.v1" }).sort(([a], [b]) => a.localeCompare(b))));
  assert.equal(result.digest, createHash("sha256").update(canonical).digest("hex"));
  assert.match(result.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await page.getByRole("button", { name: "Copy command" }).click();
  await page.waitForFunction(() => document.querySelector("output").textContent === "Copied");
  const paste = page.getByRole("textbox", { name: "Paste here" });
  await paste.focus();
  await paste.press("ControlOrMeta+V");
  assert.equal(await paste.inputValue(), "raft-computer start\n中文");
  assert.deepEqual(errors, []);
  console.log("HTTP browser features passed: native crypto untouched, provider digest, UUID, and real copy/paste.");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
