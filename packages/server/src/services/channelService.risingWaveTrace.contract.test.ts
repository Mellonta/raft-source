import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./channelService.ts", import.meta.url), "utf8");
const risingWaveSource = readFileSync(new URL("../db/risingwave.ts", import.meta.url), "utf8");
const risingWaveTraceSource = readFileSync(new URL("../tracing/risingWaveInboxTrace.ts", import.meta.url), "utf8");

test("RisingWave inbox routes inject typed failure context into db.query.failed", () => {
  for (const route of ["opts.filter", "\"channel_unread\"", "\"sidebar_summary\""]) {
    assert.match(
      source,
      new RegExp(`risingWaveInboxFailureAttrs\\(\\{[\\s\\S]*route: ${route}[\\s\\S]*queryName\\b`),
      `missing typed failure attrs for ${route}`,
    );
  }
});

test("RW inbox query errors are terminal on every route — no fail-soft ladder survives", () => {
  // 2026-09-21 teardown: a configured-but-failing RisingWave read throws.
  // The behavioral half of this contract (throw on RW failure, throw when RW
  // is unconfigured) lives in risingwaveNoFallback.test.ts; this pin keeps the
  // fail-soft decision vocabulary out of the serving module's source.
  assert.doesNotMatch(source, /isRisingWaveInboxFailSoftError/);
  assert.doesNotMatch(source, /canFailSoft/);
  assert.doesNotMatch(source, /failSoftReason/);
  assert.doesNotMatch(source, /recordInboxBackendFailed/);
});

test("RW pool timeout and trace timeout use the same bounded getter", () => {
  assert.match(risingWaveSource, /export function getRisingWaveConnectionTimeoutMillis/);
  assert.match(risingWaveSource, /connectionTimeoutMillis: getRisingWaveConnectionTimeoutMillis\(\)/);
  assert.match(risingWaveTraceSource, /timeout_ms: getRisingWaveConnectionTimeoutMillis\(\)/);
  assert.doesNotMatch(source, /timeoutMs:/);
  assert.doesNotMatch(source, /RISINGWAVE_CONNECTION_TIMEOUT_MS/);
});
