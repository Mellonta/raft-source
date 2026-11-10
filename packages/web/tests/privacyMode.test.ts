import { afterEach, expect, test, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

test.each(["enabled", "unavailable", "invalid"])("privacy bootstrap blocks optional collection: %s", async (mode) => {
  vi.resetModules();
  const meta = { httpEquiv: "", content: "" };
  vi.stubGlobal("location", { href: "https://portal.test/s/private" });
  vi.stubGlobal("document", { head: { append: vi.fn() }, createElement: () => meta });
  const send = vi.fn().mockImplementation(async () => {
    if (mode === "unavailable") throw new Error("offline");
    return Response.json(mode === "invalid" ? { enabled: "false" } : { enabled: true });
  });
  vi.stubGlobal("fetch", send);
  vi.stubGlobal("crypto", undefined);
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("unnecessary access"); }, setItem: vi.fn() });
  const { initializeBrowserPrivacy, browserPrivacyMode } = await import("@botiverse/raft-shared/src/browserPrivacy");
  await initializeBrowserPrivacy("https://api.test/api", "https://socket.test");
  expect(browserPrivacyMode()).toBe(true);
  expect(send.mock.calls[0][0].href).toBe("https://api.test/api/privacy-mode");
  expect(send.mock.calls[0][1]).toMatchObject({ credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
  expect(meta.content).toContain("wss://socket.test");
  vi.stubEnv("VITE_WEB_TRACE_URL", "https://collector.invalid");
  const analytics = await import("../src/analytics/track");
  const visits = await import("../src/analytics/publicVisits");
  const consent = await import("../src/analytics/publicVisitorConsent");
  const trace = await import("../src/utils/webAuthTrace");
  analytics.setProductEventServerIdGetter(() => { throw new Error("must not resolve identity"); });
  analytics.trackEvent("community_cn_qr_page_view", { from: "direct" });
  await analytics.flushProductEvents();
  consent.applyPublicVisitorIdMode("default_on");
  consent.setPublicVisitorConsent("accepted");
  expect(consent.publicVisitorId()).toBeNull();
  visits.recordPublicVisit("private", "public_page_viewed");
  expect(trace.readAuthBootInitTraceAttrs()).toEqual({});
  expect(trace.startWebSpan("web.http.client").traceId).toBe("");
  await trace.emitAuthTraceAndFlushBeforeUnload("slock.auth.session_cleared");
  await Promise.resolve();
  expect(send).toHaveBeenCalledTimes(1); // only the anonymous same-deployment policy read
  const { getComputerCommands } = await import("../src/utils/computerSetupCommand");
  for (const platform of ["mac-linux", "windows"] as const) {
    for (const deployment of ["production", "staging", "slockdev"]) {
      const commands = getComputerCommands("test", deployment, "https://api.test", { platform });
      expect(commands?.install).toBe("");
      expect(commands?.installAndSetup).toBeNull();
      expect(commands?.setup).toContain("--server-url https://api.test");
      expect(commands?.setup).toContain("RAFT_PRIVACY_MODE");
      expect(JSON.stringify(commands)).not.toMatch(/raft\.build|botiverse\.dev/);
    }
  }
});

test("a stale vendor API in a self-hosted bundle cannot authorize its own use", async () => {
  vi.resetModules();
  vi.stubGlobal("location", { href: "https://portal.internal/s/confidential" });
  const meta = { content: "" };
  vi.stubGlobal("document", { head: { append: vi.fn() }, createElement: () => meta });
  const send = vi.fn(async (_url: URL) => Response.json({ enabled: true }));
  vi.stubGlobal("fetch", send);
  const { initializeBrowserPrivacy } = await import("@botiverse/raft-shared/src/browserPrivacy");
  await expect(initializeBrowserPrivacy("https://api.raft.build/api", "wss://api.slock.ai")).rejects.toThrow(/your Raft deployment/);
  expect(String(send.mock.calls[0]?.[0])).toBe("https://portal.internal/api/privacy-mode");
  expect(send).toHaveBeenCalledTimes(1);
  expect(meta.content).not.toMatch(/raft\.build|slock\.ai/);
});

test("an explicit false response keeps upstream behavior and installs no private CSP", async () => {
  vi.resetModules();
  vi.stubGlobal("location", { href: "https://portal.test/" });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ enabled: false })));
  const { initializeBrowserPrivacy, browserPrivacyMode } = await import("@botiverse/raft-shared/src/browserPrivacy");
  await initializeBrowserPrivacy("/api");
  expect(browserPrivacyMode()).toBe(false);
});
