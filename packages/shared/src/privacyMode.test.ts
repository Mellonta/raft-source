import { afterEach, expect, test, vi } from "vitest";
import { privacyModeEnabled, assertPrivacyServiceUrl } from "./privacyMode";

afterEach(() => vi.unstubAllEnvs());

test("privacy is opt-in and an invalid setting is not treated as off", () => {
  expect(privacyModeEnabled({})).toBe(false);
  for (const value of ["0", "false"]) expect(privacyModeEnabled({ RAFT_PRIVACY_MODE: value })).toBe(false);
  for (const value of ["1", "TRUE"]) expect(privacyModeEnabled({ RAFT_PRIVACY_MODE: value })).toBe(true);
  expect(() => privacyModeEnabled({ RAFT_PRIVACY_MODE: "typo" })).toThrow(/RAFT_PRIVACY_MODE/);
});

test("a stale vendor endpoint is rejected only in private mode, without matching unrelated domains", () => {
  vi.stubEnv("RAFT_PRIVACY_MODE", "1");
  expect(() => assertPrivacyServiceUrl("https://API.raft.build./agent")).toThrow(/vendor/);
  expect(() => assertPrivacyServiceUrl("https://raft.build.example.org")).not.toThrow();
  expect(() => assertPrivacyServiceUrl("https://github.com/Botiverse/desktop-beta/releases")).toThrow(/vendor/);
  expect(() => assertPrivacyServiceUrl("https://github.com/%62otiverse/desktop-beta/releases")).toThrow(/vendor/);
  expect(() => assertPrivacyServiceUrl("https://github.com/Mellonta/raft-source/releases")).not.toThrow();
  expect(() => assertPrivacyServiceUrl("https://api.openai.com/v1/responses")).not.toThrow();
  expect(() => assertPrivacyServiceUrl("https://api.anthropic.com/v1/messages")).not.toThrow();
  vi.stubEnv("RAFT_PRIVACY_MODE", "0");
  expect(() => assertPrivacyServiceUrl("https://api.raft.build")).not.toThrow();
});
