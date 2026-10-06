import assert from "node:assert/strict";
import { createNodeExecutionContext } from "./nodeExecutionContext";

// Task #426: the Node ctx must observe every background promise so a rejection
// is logged + counted instead of surfacing as an unhandledRejection.
test("node execution context observes background rejections", async () => {
  const ctx = createNodeExecutionContext();
  const lines: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === "string") lines.push(args[0]);
  };
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on("unhandledRejection", onUnhandled);
  try {
    ctx.waitUntil(Promise.reject(new Error("boom")));
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled, 0);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    console.error = originalError;
  }
  assert.equal(lines.filter((line) => line === "[TraceUploadWorker] background_task_failed").length, 1);
});

test("node execution context lets a fulfilled background promise through silently", async () => {
  const ctx = createNodeExecutionContext();
  const lines: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === "string") lines.push(args[0]);
  };
  try {
    ctx.waitUntil(Promise.resolve("ok"));
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.error = originalError;
  }
  assert.equal(lines.length, 0);
});
