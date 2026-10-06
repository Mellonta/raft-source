import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { daemonFetch, installDaemonFetchMockForTests, setDaemonFetchImplForTests } from "../daemonFetch";
import { permitRealNetworkInThisFile, takeRecordedNetworkAttempts } from "./networkGuard";

// The guard is installed by vitest `setupFiles`; these tests read its records
// directly so the afterEach hook in the setup file sees an empty list.

test("daemonFetch to a non-loopback host is rejected and recorded with method and URL", async () => {
  await assert.rejects(
    daemonFetch("https://daemon.example.com/internal/x", { method: "DELETE" }),
    /do not reach the network: daemonFetch DELETE https:\/\/daemon\.example\.com\/internal\/x/,
  );
  assert.deepEqual(takeRecordedNetworkAttempts(), [
    { transport: "daemonFetch", method: "DELETE", url: "https://daemon.example.com/internal/x" },
  ]);
});

test("globalThis.fetch to a non-loopback host is rejected and recorded", async () => {
  await assert.rejects(fetch("https://daemon.example.com/y"), /fetch GET https:\/\/daemon\.example\.com\/y/);
  assert.deepEqual(takeRecordedNetworkAttempts(), [
    { transport: "fetch", method: "GET", url: "https://daemon.example.com/y" },
  ]);
});

test("an .invalid name cannot resolve, so it passes through and is not recorded", async () => {
  await assert.rejects(daemonFetch("http://never-resolves.invalid/x"), (error: unknown) =>
    !(error instanceof Error && error.message.includes("do not reach the network")));
  assert.deepEqual(takeRecordedNetworkAttempts(), []);
});

test("loopback requests pass through to the real transport", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("local ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await daemonFetch(`http://127.0.0.1:${port}/ping`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "local ok");
    assert.deepEqual(takeRecordedNetworkAttempts(), []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the guard survives a per-test daemonFetch mock and its restore", async () => {
  const restore = installDaemonFetchMockForTests((async () => new Response("mocked")) as typeof fetch);
  try {
    assert.equal(await (await daemonFetch("https://daemon.example.com/mocked")).text(), "mocked");
  } finally {
    restore();
  }
  await assert.rejects(daemonFetch("https://daemon.example.com/after-restore"));
  assert.deepEqual(takeRecordedNetworkAttempts().map((attempt) => attempt.url), [
    "https://daemon.example.com/after-restore",
  ]);
});

test("setDaemonFetchImplForTests(undefined) returns to the guard, not to the raw transport", async () => {
  setDaemonFetchImplForTests((async () => new Response("impl")) as never);
  try {
    assert.equal(await (await daemonFetch("https://daemon.example.com/impl")).text(), "impl");
  } finally {
    setDaemonFetchImplForTests(undefined);
  }
  await assert.rejects(daemonFetch("https://daemon.example.com/after-reset"));
  assert.deepEqual(takeRecordedNetworkAttempts().map((attempt) => attempt.url), [
    "https://daemon.example.com/after-reset",
  ]);
});

// Last: permitting a host is file-wide state, so nothing after this may rely on
// that host being guarded. Only the negative half is checked; sending to the
// permitted host would itself be a real request.
test("permitting one host keeps every other host guarded, and needs a reason and a host", async () => {
  assert.throws(() => permitRealNetworkInThisFile("", ["permitted.example.com"]));
  assert.throws(() => permitRealNetworkInThisFile("no hosts", []));
  permitRealNetworkInThisFile("negative half of the opt-out contract", ["permitted.example.com"]);
  await assert.rejects(daemonFetch("https://daemon.example.com/still-guarded"), /do not reach the network/);
  assert.deepEqual(takeRecordedNetworkAttempts().map((attempt) => attempt.url), [
    "https://daemon.example.com/still-guarded",
  ]);
});
