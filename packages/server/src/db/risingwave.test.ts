import { strict as assert } from "node:assert";
import type pg from "pg";
import {
  asRisingWaveOverload,
  getRisingWaveConnectionTimeoutMillis,
  getRisingWaveInboxRfc056ServingMode,
  queryRisingWave,
  RisingWaveOverloadedError,
} from "./risingwave";
import { risingWaveInboxFailureAttrs } from "../tracing/risingWaveInboxTrace";

test("RisingWave connection timeout defaults to a bounded fail-soft value", () => {
  assert.equal(getRisingWaveConnectionTimeoutMillis({}), 1_000);
  assert.equal(getRisingWaveConnectionTimeoutMillis({ RISINGWAVE_CONNECTION_TIMEOUT_MS: "750" }), 750);
  assert.equal(getRisingWaveConnectionTimeoutMillis({ RISINGWAVE_CONNECTION_TIMEOUT_MS: "100" }), 250);
  assert.equal(getRisingWaveConnectionTimeoutMillis({ RISINGWAVE_CONNECTION_TIMEOUT_MS: "60000" }), 10_000);
  assert.equal(getRisingWaveConnectionTimeoutMillis({ RISINGWAVE_CONNECTION_TIMEOUT_MS: "1000.9" }), 1_000);
  assert.equal(getRisingWaveConnectionTimeoutMillis({ RISINGWAVE_CONNECTION_TIMEOUT_MS: "not-a-number" }), 1_000);
});

test("RFC056 serving mode is fail-closed and requires an explicit shadow or on value", () => {
  assert.equal(getRisingWaveInboxRfc056ServingMode({}), "off");
  assert.equal(getRisingWaveInboxRfc056ServingMode({ RISINGWAVE_INBOX_RFC056_SERVING_MODE: "" }), "off");
  assert.equal(getRisingWaveInboxRfc056ServingMode({ RISINGWAVE_INBOX_RFC056_SERVING_MODE: "invalid" }), "off");
  assert.equal(getRisingWaveInboxRfc056ServingMode({ RISINGWAVE_INBOX_RFC056_SERVING_MODE: " OFF " }), "off");
  assert.equal(getRisingWaveInboxRfc056ServingMode({ RISINGWAVE_INBOX_RFC056_SERVING_MODE: " Shadow " }), "shadow");
  assert.equal(getRisingWaveInboxRfc056ServingMode({ RISINGWAVE_INBOX_RFC056_SERVING_MODE: "ON" }), "on");
});

test("a saturated RisingWave pool (acquire timeout) surfaces as RisingWaveOverloadedError, still classified rw_acquire_timeout", async () => {
  const acquireTimeout = new Error("timeout exceeded when trying to connect");
  const pool = { connect: async () => { throw acquireTimeout; } } as unknown as pg.Pool;
  const error = await queryRisingWave(pool, "SELECT 1").then(() => null, (err: unknown) => err);
  assert.ok(error instanceof RisingWaveOverloadedError);
  assert.equal((error as Error).cause, acquireTimeout);
  assert.equal(risingWaveInboxFailureAttrs({ route: "all", error, contractVersion: 2 }).error_kind, "rw_acquire_timeout");

  // Other failures pass through unchanged; an overload is not wrapped twice.
  const queryError = new Error("relation does not exist");
  assert.equal(asRisingWaveOverload(queryError), queryError);
  assert.equal(asRisingWaveOverload(error), error);
});
