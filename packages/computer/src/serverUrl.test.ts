import assert from "node:assert/strict";

import {
  DEFAULT_SLOCK_SERVER_URL,
  LEGACY_PRODUCTION_SERVER_URL,
  RAFT_SERVER_URL_ENV,
  canonicalizeServerUrl,
  resolveServerUrl,
  resolveServerUrlEnv,
  SLOCK_SERVER_URL_ENV,
} from "./serverUrl";

test("resolveServerUrl requires an explicit self-hosted server", () => {
  assert.throws(() => resolveServerUrl(undefined, "", "   "), /self-hosted server URL is required/);
});

test("resolveServerUrl preserves explicit precedence", () => {
  assert.equal(
    resolveServerUrl(undefined, " https://session.example.test ", "https://env.example.test"),
    "https://session.example.test",
  );
  assert.equal(
    resolveServerUrl(" https://flag.example.test ", "https://session.example.test"),
    "https://flag.example.test",
  );
});

test("old production endpoints cannot reconnect to Botiverse", () => {
  for (const url of [LEGACY_PRODUCTION_SERVER_URL, DEFAULT_SLOCK_SERVER_URL, "https://api-aws-staging.botiverse.dev"]) {
    assert.throws(() => canonicalizeServerUrl(url), /Botiverse-hosted services are disabled/);
    assert.throws(() => resolveServerUrl(url), /Botiverse-hosted services are disabled/);
  }
});

test("resolveServerUrlEnv accepts RAFT alias while preserving SLOCK precedence", () => {
  assert.equal(
    resolveServerUrlEnv({ [RAFT_SERVER_URL_ENV]: "https://raft.example.test" }),
    "https://raft.example.test",
  );
  assert.equal(
    resolveServerUrlEnv({
      [SLOCK_SERVER_URL_ENV]: "https://slock.example.test",
      [RAFT_SERVER_URL_ENV]: "https://raft.example.test",
    }),
    "https://slock.example.test",
  );
});
