import assert from "node:assert/strict";
import { test } from "vitest";

import { transientTransactionSqlState, withTransientTransactionRetry } from "./transientTransactionRetry";

function pgError(code: string): Error {
  return Object.assign(new Error(`pg ${code}`), { code });
}

const noSleep = async () => {};
const topLevel = () => false;

test("classifies 40P01/40001 through a wrapped cause chain and nothing else", () => {
  assert.equal(transientTransactionSqlState(pgError("40P01")), "40P01");
  assert.equal(transientTransactionSqlState(new Error("drizzle", { cause: pgError("40001") })), "40001");
  assert.equal(transientTransactionSqlState(pgError("23505")), null);
  assert.equal(transientTransactionSqlState(pgError("55P03")), null);
  assert.equal(transientTransactionSqlState("40P01"), null);
  assert.equal(transientTransactionSqlState(null), null);
});

test("a deadlock-aborted transaction is re-run once and its result returned", async () => {
  const attempts: number[] = [];
  const retries: Array<{ attempt: number; sqlState: string }> = [];
  const result = await withTransientTransactionRetry(async (attempt) => {
    attempts.push(attempt);
    if (attempt === 1) throw new Error("wrapped", { cause: pgError("40P01") });
    return "committed";
  }, { sleep: noSleep, isNested: topLevel, onRetry: ({ attempt, sqlState }) => retries.push({ attempt, sqlState }) });
  assert.equal(result, "committed");
  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual(retries, [{ attempt: 1, sqlState: "40P01" }]);
});

test("the budget is bounded and the last conflict is rethrown unchanged", async () => {
  let calls = 0;
  const lastError = pgError("40001");
  await assert.rejects(
    withTransientTransactionRetry(async () => {
      calls += 1;
      throw calls === 3 ? lastError : pgError("40P01");
    }, { sleep: noSleep, isNested: topLevel }),
    (error) => error === lastError,
  );
  assert.equal(calls, 3);
});

test("non-transient errors are never retried", async () => {
  let calls = 0;
  await assert.rejects(
    withTransientTransactionRetry(async () => {
      calls += 1;
      throw pgError("23505");
    }, { sleep: noSleep, isNested: topLevel }),
    /pg 23505/,
  );
  assert.equal(calls, 1);
});

test("inside an ambient outer transaction the conflict propagates to its owner", async () => {
  let calls = 0;
  await assert.rejects(
    withTransientTransactionRetry(async () => {
      calls += 1;
      throw pgError("40P01");
    }, { sleep: noSleep, isNested: () => true }),
    /pg 40P01/,
  );
  assert.equal(calls, 1);
});

test("retry delays are small, positive and jittered", async () => {
  const delays: number[] = [];
  await withTransientTransactionRetry(async (attempt) => {
    if (attempt < 3) throw pgError("40P01");
    return null;
  }, { sleep: async (ms) => { delays.push(ms); }, isNested: topLevel, baseDelayMs: 20 });
  assert.equal(delays.length, 2);
  assert.ok(delays[0]! >= 10 && delays[0]! < 30, `first delay ${delays[0]}`);
  assert.ok(delays[1]! >= 20 && delays[1]! < 60, `second delay ${delays[1]}`);
});
