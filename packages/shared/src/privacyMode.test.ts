import { afterEach, expect, vi } from "vitest";
import { assertPrivacyServiceUrl } from "./privacyTransport";
import assert from "node:assert/strict";
import { PRIVACY_MODE_ENV, PrivacyModeConfigError, parsePrivacyMode, privacyModeFromEnv } from "./privacyMode";

test("unset, empty and the off words are off", () => {
  for (const raw of [undefined, "", "  ", "0", "false", "off", "no", "OFF", " No "]) {
    assert.equal(parsePrivacyMode(raw), false, String(raw));
  }
});

test("the on words are on, in any case and with surrounding space", () => {
  for (const raw of ["1", "true", "on", "yes", "ON", " True "]) {
    assert.equal(parsePrivacyMode(raw), true, raw);
  }
});

test("anything else is a configuration error, never a guess", () => {
  for (const raw of ["2", "enabled", "y", "privacy"]) {
    assert.throws(() => parsePrivacyMode(raw), PrivacyModeConfigError, raw);
  }
});

test("privacyModeFromEnv reads RAFT_PRIVACY_MODE", () => {
  assert.equal(PRIVACY_MODE_ENV, "RAFT_PRIVACY_MODE");
  assert.equal(privacyModeFromEnv({}), false);
  assert.equal(privacyModeFromEnv({ RAFT_PRIVACY_MODE: "on" }), true);
  assert.throws(() => privacyModeFromEnv({ RAFT_PRIVACY_MODE: "maybe" }), /RAFT_PRIVACY_MODE/);
});

afterEach(() => vi.unstubAllEnvs());

test("a stale vendor endpoint is rejected only in private mode, without matching unrelated domains", () => {
  vi.stubEnv("RAFT_PRIVACY_MODE", "1");
  expect(() => assertPrivacyServiceUrl("https://API.raft.build./agent")).toThrow(/vendor/);
  for (const host of ["antiproton.ai", "canary.antiproton.ai", "raft-artifacts.com", "w-test.raftusercontent.com", "lens.botiverse.workers.dev"]) {
    expect(() => assertPrivacyServiceUrl(`https://${host}/`)).toThrow(/vendor/);
  }
  expect(() => assertPrivacyServiceUrl("https://lens.acme.workers.dev")).not.toThrow();
  expect(() => assertPrivacyServiceUrl("https://raft.build.example.org")).not.toThrow();
  expect(() => assertPrivacyServiceUrl("https://github.com/Botiverse/desktop-beta/releases")).toThrow(/vendor/);
  expect(() => assertPrivacyServiceUrl("https://github.com/%62otiverse/desktop-beta/releases")).toThrow(/vendor/);
  expect(() => assertPrivacyServiceUrl("https://github.com/Mellonta/raft-source/releases")).not.toThrow();
  expect(() => assertPrivacyServiceUrl("https://api.openai.com/v1/responses")).not.toThrow();
  expect(() => assertPrivacyServiceUrl("https://api.anthropic.com/v1/messages")).not.toThrow();
  vi.stubEnv("RAFT_PRIVACY_MODE", "0");
  expect(() => assertPrivacyServiceUrl("https://api.raft.build")).not.toThrow();
});
