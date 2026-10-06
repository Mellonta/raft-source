import assert from "node:assert/strict";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { ApnsRequestTimeoutError, createApnsHttpClient } from "./pushService";

// The outbox drain calls APNs while holding the channel writer fence, so an
// APNs request that never answers must fail on its own deadline instead of
// keeping that transaction open.

async function withSilentHttp2Server<T>(run: (authority: string, streams: () => number) => Promise<T>): Promise<T> {
  const server = http2.createServer();
  let streamCount = 0;
  server.on("stream", () => {
    streamCount += 1; // accept the request and never respond
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`, () => streamCount);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("APNs requests fail with a timeout when the provider never answers", async () => {
  await withSilentHttp2Server(async (authority, streams) => {
    const client = createApnsHttpClient(200);
    const started = Date.now();
    await assert.rejects(
      client({ authority, path: "/3/device/token", headers: {}, body: { aps: {} } }),
      (error: unknown) => error instanceof ApnsRequestTimeoutError,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 190, `timed out too early: ${elapsed}ms`);
    assert.ok(elapsed < 2_000, `timeout was not enforced: ${elapsed}ms`);
    assert.equal(streams(), 1, "the request must have reached the provider before timing out");
  });
});
