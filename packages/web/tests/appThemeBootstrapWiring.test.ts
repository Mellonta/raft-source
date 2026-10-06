import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import viteConfig from "../vite.config";

const webRoot = fileURLToPath(new URL("../", import.meta.url));

test("the theme bootstrap is a fixed same-origin parser-blocking script", () => {
  const html = readFileSync(`${webRoot}index.html`, "utf8");
  const script = readFileSync(`${webRoot}public/app-theme-bootstrap.js`, "utf8");
  const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
  const scriptTag = head.match(/<script\b[^>]*>/)?.[0] ?? "";

  assert.match(scriptTag, /src="\/app-theme-bootstrap\.js"/);
  assert.doesNotMatch(scriptTag, /\basync\b|\bdefer\b/);
  assert.ok(script.startsWith("(function applyAppThemeBootstrap("));
  assert.doesNotMatch(script, /__name|VITE_RAFT_MULTITHEME_POLICY|allowLocalOverride/);

  const configuredPlugins = Array.isArray(viteConfig.plugins)
    ? viteConfig.plugins.flat(Number.POSITIVE_INFINITY)
    : [];
  assert.equal(configuredPlugins.some((candidate) => (
    typeof candidate === "object"
    && candidate !== null
    && "name" in candidate
    && candidate.name === "raft-app-theme-bootstrap"
  )), false);
});
