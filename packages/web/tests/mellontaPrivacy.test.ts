import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

test("usage tracking neither allocates identifiers nor schedules or sends events", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal("crypto", undefined);
  const fetchImpl = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchImpl);
  const analytics = await import("../src/analytics/track");
  const identity = vi.fn(() => "private-workspace");
  analytics.setProductEventServerIdGetter(identity);
  analytics.trackEvent("community_cn_qr_page_view", { from: "direct" });
  await analytics.flushProductEvents();
  await analytics.flushProductEvents({ onPageHide: true });
  assert.equal(identity.mock.calls.length, 0);
  assert.equal(fetchImpl.mock.calls.length, 0);
  assert.equal(vi.getTimerCount(), 0);
});

test("configured browser trace receiver cannot enable normal or urgent exports", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv("VITE_WEB_TRACE_URL", "https://vendor.test");
  const trace = await import("../src/utils/webAuthTrace");
  trace.__resetAuthTraceForTest({ traceUrl: "https://vendor.test" });
  const fetchImpl = vi.fn<typeof fetch>();
  trace.setAuthTraceFetchForTest(fetchImpl);
  trace.setAuthTraceServerIdGetter(() => "private-workspace");
  trace.setAuthTracePrincipalIdGetter(() => "private-user");
  trace.emitAuthTrace("slock.auth.boot_init");
  trace.emitAuthTraceAndFlush("slock.auth.verdict");
  await trace.emitAuthTraceAndFlushBeforeUnload("slock.auth.session_cleared");
  await trace.emitWebEventAndFlushBeforeUnload("slock.client_error", { message: "private" });
  const span = trace.startWebSpan("web.http.client");
  span.end("ok");
  await trace.flushAuthTraces();
  assert.equal(span.traceId, "");
  assert.equal(fetchImpl.mock.calls.length, 0);
  assert.equal(vi.getTimerCount(), 0);
});

test("portal install commands use the fork and its own server", async () => {
  const { computerInstallCommand, windowsComputerInstallCommand, getComputerCommands } = await import("../src/utils/computerSetupCommand");
  assert.match(computerInstallCommand("production"), /github.com\/Mellonta\/raft-source\/releases\/latest\/download\/install.sh/);
  assert.match(computerInstallCommand("production", "1.0.43-mellonta.3"), /download\/1.0.43-mellonta.3\/install.sh/);
  assert.doesNotMatch(computerInstallCommand("production", "1.0.43"), /download\/1.0.43\//);
  assert.match(windowsComputerInstallCommand(), /Linux x64 and ARM64/);
  const commands = getComputerCommands("mine", "staging", "http://my-server.test:8001");
  assert.match(commands!.setup, /--server-url http:\/\/my-server.test:8001/);
  assert.doesNotMatch(JSON.stringify(commands), /botiverse.dev|cdn.raft.build|api.raft.build/);
});
