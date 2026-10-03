import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, test, vi } from "vitest";
import { prepareManagedMcpRuntimeProxy } from "./managedMcpRuntimeProxy.js";

afterEach(() => {
  vi.restoreAllMocks();
});

test("managed MCP is skipped before discovery or opening a listener", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const listenSpy = vi.spyOn(http, "createServer");
  assert.equal(await prepareManagedMcpRuntimeProxy({
    agentId: "agent-1",
    launchId: "launch-1",
    serverUrl: "https://server.test",
    agentCredentialKey: "sk_agent_test",
  }), null);
  assert.equal(fetchSpy.mock.calls.length, 0);
  assert.equal(listenSpy.mock.calls.length, 0);
});
