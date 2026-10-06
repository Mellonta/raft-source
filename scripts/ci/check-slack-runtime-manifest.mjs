#!/usr/bin/env node
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { readSlackRuntimeBuild, SLACK_RUNTIME_MANIFEST_URL } from "../../packages/server/src/test/slackBridgeRuntimeBuildManifest.ts";

const args = process.argv.slice(2);
const update = args[0] === "--write";
if (update) args.shift();
assert(args.length === 0 || (args.length === 2 && args[0] === "--manifest"),
  "Usage: node scripts/ci/check-slack-runtime-manifest.mjs [--write] [--manifest path]");
const url = args.length ? pathToFileURL(args[1]) : SLACK_RUNTIME_MANIFEST_URL;
const { manifest, actualFingerprint } = await readSlackRuntimeBuild(url);
if (update) {
  await writeFile(url, JSON.stringify({ ...manifest, fingerprint: actualFingerprint }, null, 2) + "\n");
} else {
  assert.equal(actualFingerprint, manifest.fingerprint,
    "Slack runtime manifest is stale. Review the explicit source list, then run node scripts/ci/check-slack-runtime-manifest.mjs --write");
}
console.log(`Slack runtime manifest ${update ? "updated" : "fresh"}: ${manifest.sources.length} sources, ${actualFingerprint}`);
