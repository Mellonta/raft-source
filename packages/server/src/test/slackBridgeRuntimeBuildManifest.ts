import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const SLACK_RUNTIME_MANIFEST_URL = new URL("./slackBridgeRuntimeBuildManifest.json", import.meta.url);

// This explicit list is owned by the Slack change author/reviewer. Hash freshness
// proves listed bytes only; it does not discover security-critical dependencies.
export async function readSlackRuntimeBuild(manifestUrl = SLACK_RUNTIME_MANIFEST_URL) {
  const value: unknown = JSON.parse(await readFile(manifestUrl, "utf8"));
  assert(value && typeof value === "object", "Slack runtime manifest must be an object");
  assert("schema" in value && value.schema === "slack-bridge-runtime-build-manifest.v1", "Unsupported Slack runtime manifest schema");
  assert("sources" in value && Array.isArray(value.sources) && value.sources.length > 0, "Slack runtime sources must be nonempty");
  const sources = value.sources.map((source: unknown) => {
    assert(typeof source === "string" && source.startsWith("../") && source.endsWith(".ts"), "Invalid Slack runtime source path");
    assert(new URL(source, manifestUrl).href.startsWith(new URL("../", manifestUrl).href), "Slack runtime source escapes src directory");
    return source;
  });
  assert(new Set(sources).size === sources.length, "Duplicate Slack runtime source");
  assert("fingerprint" in value && typeof value.fingerprint === "string" && /^[a-f0-9]{64}$/.test(value.fingerprint), "Invalid Slack runtime fingerprint");
  const manifest = { schema: value.schema, sources, fingerprint: value.fingerprint };
  // Preserve v1: SHA-256 of raw source bytes concatenated in declared order.
  const hash = createHash("sha256");
  for (const source of sources) hash.update(await readFile(new URL(source, manifestUrl)));
  return { manifest, actualFingerprint: hash.digest("hex") };
}
