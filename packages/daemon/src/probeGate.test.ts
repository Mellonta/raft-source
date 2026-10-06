import assert from "node:assert/strict";

import { ProbeGate } from "./probeGate";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("concurrent requests for the same key share one run and one result", async () => {
  const gate = new ProbeGate(2);
  const pending = deferred<string>();
  let starts = 0;
  const task = () => {
    starts += 1;
    return pending.promise;
  };
  const first = gate.run("runtime_models:cursor", task);
  const second = gate.run("runtime_models:cursor", task);
  const third = gate.run("runtime_models:cursor", task);
  await tick();
  assert.equal(starts, 1, "only one probe process for overlapping requests");
  pending.resolve("241 models");
  assert.deepEqual(await Promise.all([first, second, third]), ["241 models", "241 models", "241 models"]);
});

test("after a run settles, the next request for the key starts a fresh run", async () => {
  const gate = new ProbeGate(2);
  let starts = 0;
  const task = async () => ++starts;
  assert.equal(await gate.run("k", task), 1);
  assert.equal(await gate.run("k", task), 2);
  assert.deepEqual(gate.activeKeys, []);
});

test("different keys run up to the limit; the rest wait in order", async () => {
  const gate = new ProbeGate(2);
  const a = deferred<void>();
  const b = deferred<void>();
  const c = deferred<void>();
  const started: string[] = [];
  const run = (key: string, d: { promise: Promise<void> }) => gate.run(key, () => {
    started.push(key);
    return d.promise;
  });
  const pa = run("a", a);
  const pb = run("b", b);
  const pc = run("c", c);
  await tick();
  assert.deepEqual(started, ["a", "b"], "the third waits for a free slot");
  a.resolve();
  await pa;
  await tick();
  assert.deepEqual(started, ["a", "b", "c"], "a freed slot starts the next waiter");
  b.resolve();
  c.resolve();
  await Promise.all([pb, pc]);
});

test("a failing run rejects every joined caller and frees the key and the slot", async () => {
  const gate = new ProbeGate(1);
  const failing = deferred<string>();
  const first = gate.run("k", () => failing.promise);
  const joined = gate.run("k", () => Promise.resolve("never"));
  failing.reject(new Error("probe crashed"));
  await assert.rejects(first, /probe crashed/);
  await assert.rejects(joined, /probe crashed/);
  assert.equal(await gate.run("k", async () => "fresh"), "fresh", "the key is usable again");
  assert.equal(await gate.run("other", async () => "slot freed"), "slot freed");
});

test("the limit must be a positive integer or Infinity", () => {
  assert.throws(() => new ProbeGate(0), /positive integer/);
  assert.throws(() => new ProbeGate(1.5), /positive integer/);
  assert.doesNotThrow(() => new ProbeGate(Number.POSITIVE_INFINITY));
});

test("the default gate never queues different keys: a third slow probe starts at once", async () => {
  // Any wait counts against the server's 20s request budget, so different
  // runtimes (and usage refreshes) must not queue behind each other.
  const gate = new ProbeGate();
  const slow = [deferred<void>(), deferred<void>(), deferred<void>()];
  const started: string[] = [];
  const runs = ["runtime_models:cursor", "runtime_models:codex", "runtime_account_usage:kimi"].map((key, index) =>
    gate.run(key, () => {
      started.push(key);
      return slow[index]!.promise;
    }));
  await tick();
  assert.deepEqual(started, ["runtime_models:cursor", "runtime_models:codex", "runtime_account_usage:kimi"]);
  for (const d of slow) d.resolve();
  await Promise.all(runs);
});
