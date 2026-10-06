import "./helpers/domSetup";

import assert from "node:assert/strict";

// Real-behaviour guard (task #84): with the REAL shareableWebOrigin (not mocked), in the
// desktop shell (raftDesktop.isDesktop) and with the build-time VITE_FRONTEND_URL present,
// buildMessagePermalink must emit an https web URL — never the `app://raft` page origin
// (which is unopenable when copied). compiledFrontendOrigin is read at module load, so we
// stub the env and reset modules BEFORE importing so the fresh module picks it up.
type DesktopWindow = { raftDesktop?: { isDesktop?: boolean } };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  delete (window as DesktopWindow).raftDesktop;
});

test("desktop shell: buildMessagePermalink uses the compiled web origin, never app://", async () => {
  vi.stubEnv("VITE_FRONTEND_URL", "https://app.raft.build");
  vi.resetModules();
  (window as DesktopWindow).raftDesktop = { isDesktop: true };

  const { buildMessagePermalink } = await import("../src/hooks/useAppNavigate");
  const url = buildMessagePermalink("acme", "chan-1", "msg-1");

  assert.ok(url.startsWith("https://app.raft.build/"), `expected compiled web origin, got ${url}`);
  assert.doesNotMatch(url, /^app:\/\//, "must never emit an app:// permalink in the desktop shell");
  assert.match(url, /\/s\/acme\//, "keeps the server-scoped message path");
});

test("web (no desktop shell): buildMessagePermalink uses the page origin unchanged", async () => {
  vi.stubEnv("VITE_FRONTEND_URL", "https://app.raft.build");
  vi.resetModules();
  // no window.raftDesktop → not the desktop shell

  const { buildMessagePermalink } = await import("../src/hooks/useAppNavigate");
  const url = buildMessagePermalink("acme", "chan-1", "msg-1");

  // jsdom page origin (http://localhost...) — the compiled origin must NOT be used on Web.
  assert.ok(url.startsWith(window.location.origin + "/"), `expected page origin, got ${url}`);
  assert.doesNotMatch(url, /app\.raft\.build/, "Web must not switch to the compiled desktop origin");
});
