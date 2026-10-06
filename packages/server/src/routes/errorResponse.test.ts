import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";

import { RisingWaveOverloadedError } from "../db/risingwave";
import { globalJsonServerErrorHandler, respondToRisingWaveOverload, sendJsonServerError } from "./errorResponse";

async function withErrorBoundaryApp<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.get("/boom", () => {
    throw new Error('Failed query: select * from "server_members" where "server_members"."server_id" = $1 params: private-server-id');
  });
  app.get("/rw-overloaded", () => {
    throw new RisingWaveOverloadedError(new Error("timeout exceeded when trying to connect"));
  });
  app.get("/rw-overloaded-handled", (req, res) => {
    // A route catch that wraps the read error keeps it as the cause.
    const err = new Error("load failed", { cause: new RisingWaveOverloadedError(new Error("timeout exceeded when trying to connect")) });
    sendJsonServerError(req, res, { error: "Failed to get inbox", logPrefix: "test", err });
  });
  app.get("/rw-overloaded-bare-catch", (_req, res) => {
    try {
      throw new RisingWaveOverloadedError(new Error("timeout exceeded when trying to connect"));
    } catch (err) {
      if (respondToRisingWaveOverload(err, res)) return;
      res.status(500).json({ error: "Failed to get unread counts" });
    }
  });
  app.get("/typed-conflict", (_req, res) => {
    res.status(409).json({ error: "Machine has assigned agents", code: "MACHINE_HAS_ASSIGNED_AGENTS" });
  });
  app.use(globalJsonServerErrorHandler);

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

test("global JSON error boundary sanitizes uncaught 5xx route failures", async () => {
  await withErrorBoundaryApp(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/boom`);
    assert.equal(res.status, 500);
    assert.match(res.headers.get("x-slock-error-id") ?? "", /.+/);

    const body = await res.json() as { error?: string; code?: string; correlationId?: string };
    assert.deepEqual(Object.keys(body).sort(), ["code", "correlationId", "error"]);
    assert.equal(body.error, "Internal server error");
    assert.equal(body.code, "internal_server_error");
    assert.equal(body.correlationId, res.headers.get("x-slock-error-id"));

    const serialized = JSON.stringify(body);
    assert.doesNotMatch(serialized, /Failed query|server_members|params:|private-server-id/i);
  });
});

test("global JSON error boundary does not rewrite explicit typed route responses", async () => {
  await withErrorBoundaryApp(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/typed-conflict`);
    assert.equal(res.status, 409);
    assert.equal(res.headers.get("x-slock-error-id"), null);
    assert.deepEqual(await res.json(), {
      error: "Machine has assigned agents",
      code: "MACHINE_HAS_ASSIGNED_AGENTS",
    });
  });
});

test("a saturated RisingWave pool answers 503 + Retry-After, not 500, on every error path", async () => {
  await withErrorBoundaryApp(async (baseUrl) => {
    for (const path of ["/rw-overloaded", "/rw-overloaded-handled", "/rw-overloaded-bare-catch"]) {
      const res = await fetch(`${baseUrl}${path}`);
      assert.equal(res.status, 503, path);
      assert.equal(res.headers.get("retry-after"), "2", path);
      assert.deepEqual(await res.json(), {
        error: "Temporarily overloaded, retry shortly",
        code: "rw_overloaded",
        retryable: true,
      }, path);
    }
  });
});
