import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";

import { fetch, MockAgent } from "undici";
import { vi } from "vitest";

import { buildFetchDispatcher, computerFetch } from "./proxy";
import { installerCommand } from "./externalInstaller";

test("redirected POST bodies never reach a Raft vendor in privacy mode", async () => {
  const mock = new MockAgent();
  mock.disableNetConnect();
  vi.stubEnv("NO_PROXY", "*");
  const vendor = "https://slock-trace-upload.botiverse.dev";
  const records: string[] = [];
  const endpoint = mock.get("https://raft.internal");
  const body = "confidential-test-payload";
  const redirect = (path: string, location: string) => endpoint.intercept({ method: "POST", path })
    .reply(307, "", { headers: { location } }).persist();
  redirect("/report", vendor + "/capture");
  redirect("/model", "https://provider.example/model");
  mock.get(vendor).intercept({ method: "POST", path: "/capture", body })
    .reply(() => { records.push("vendor"); return { statusCode: 200, data: "ok" }; });
  mock.get("https://provider.example").intercept({ method: "POST", path: "/model", body })
    .reply(() => { records.push("provider"); return { statusCode: 200, data: "ok" }; });
  const send = (path: string) => computerFetch("https://raft.internal" + path, { method: "POST", body, dispatcher: mock });
  try {
    vi.stubEnv("RAFT_PRIVACY_MODE", "1");
    await assert.rejects(send("/report"), (error: TypeError) => /vendor services/.test(String(error.cause)));
    assert.deepEqual(records, []);
    assert.equal(await (await send("/model")).text(), "ok");
    assert.deepEqual(records, ["provider"]);
    await assert.rejects(installerCommand(["upgrade"], { RAFT_COMPUTER_INSTALLER_DL_BASE: "https://mirror.internal" }), /installer is disabled/);
    vi.stubEnv("RAFT_PRIVACY_MODE", "0");
    assert.equal(await (await send("/report")).text(), "ok");
    assert.deepEqual(records, ["provider", "vendor"]);
  } finally {
    vi.unstubAllEnvs();
    await mock.close();
  }
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server has no TCP address");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// undici 8 only tunnels non-http targets unless `proxyTunnel: true`; Computer
// keeps tunnelling plain-http targets too, like the daemon and the agent CLI.
test("an http target goes through the proxy as a CONNECT tunnel", async () => {
  const origin = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json", connection: "close" });
    response.end(JSON.stringify({ ok: true }));
  });
  const originPort = await listen(origin);

  let proxyConnects = 0;
  // Answers only CONNECT: a forwarded (non-tunnelled) request gets 501.
  const proxy = http.createServer((_request, response) => {
    response.writeHead(501);
    response.end();
  });
  proxy.on("connect", (_request, downstream, head) => {
    proxyConnects += 1;
    const upstream = net.connect(originPort, "127.0.0.1", () => {
      downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      downstream.pipe(upstream);
      upstream.pipe(downstream);
    });
    upstream.once("error", () => downstream.destroy());
    downstream.once("error", () => upstream.destroy());
  });
  const proxyPort = await listen(proxy);

  try {
    // Only the proxy can reach this host.
    const target = `http://proxy-only.invalid:${originPort}/manifest`;
    const dispatcher = buildFetchDispatcher(target, { HTTP_PROXY: `http://127.0.0.1:${proxyPort}` });
    assert.ok(dispatcher);
    const response = await fetch(target, { dispatcher });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(proxyConnects, 1);
    await dispatcher.close();
  } finally {
    await close(proxy);
    await close(origin);
  }
});
