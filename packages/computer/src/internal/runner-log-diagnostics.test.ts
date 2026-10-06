import assert from "node:assert/strict";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readRunnerLogDiagnosticText,
  readRunnerLogTail,
  RUNNER_LOG_SCAN_BYTES,
} from "./runner-log-diagnostics";

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "raft-runner-log-diag-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("readRunnerLogDiagnosticText reads only the bounded suffix after child spawn offset", async () => {
  await withTmp(async (dir) => {
    const log = join(dir, "runner.log");
    await writeFile(
      log,
      [
        "old-prefix-that-belongs-to-an-earlier-child",
        "child-start",
        "x".repeat(128),
        "Another Slock daemon is already running (pid=1234). Lock: /tmp/daemon.lock.",
      ].join("\n"),
      { mode: 0o600 },
    );

    const diagnostic = await readRunnerLogDiagnosticText(
      log,
      "old-prefix-that-belongs-to-an-earlier-child\n".length,
      96,
    );

    assert.equal(diagnostic.includes("old-prefix"), false);
    assert.equal(diagnostic.includes("child-start"), false);
    assert.match(diagnostic, /Another Slock daemon is already running/);
    assert.ok(
      Buffer.byteLength(diagnostic, "utf8") <= 96,
      "diagnostic text must be capped before Buffer.toString() is called",
    );
  });
});

test.skipIf(process.platform === "win32")(
  "readRunnerLogDiagnosticText never allocates the size of a 5.5 GiB sparse log",
  async () => {
    await withTmp(async (dir) => {
      const log = join(dir, "runner.log");
      const fileSize = 5.5 * 1024 * 1024 * 1024;
      const marker = Buffer.from("bounded-tail-marker\n", "utf8");
      const file = await open(log, "w", 0o600);
      try {
        await file.truncate(fileSize);
        await file.write(marker, 0, marker.byteLength, fileSize - marker.byteLength);
      } finally {
        await file.close();
      }

      const originalAllocUnsafe = Buffer.allocUnsafe;
      const allocationSizes: number[] = [];
      Buffer.allocUnsafe = ((size: number) => {
        allocationSizes.push(size);
        assert.ok(size <= RUNNER_LOG_SCAN_BYTES, `attempted an unbounded ${size}-byte allocation`);
        return originalAllocUnsafe(size);
      }) as typeof Buffer.allocUnsafe;
      try {
        const diagnostic = await readRunnerLogDiagnosticText(log, 0);
        assert.match(diagnostic, /bounded-tail-marker/);
        assert.deepEqual(allocationSizes, [RUNNER_LOG_SCAN_BYTES]);
        assert.ok(Buffer.byteLength(diagnostic, "utf8") <= RUNNER_LOG_SCAN_BYTES);
      } finally {
        Buffer.allocUnsafe = originalAllocUnsafe;
      }
    });
  },
);

test.skipIf(process.platform === "win32")(
  "readRunnerLogDiagnosticText does not discover a renamed giant sibling",
  async () => {
    await withTmp(async (dir) => {
      const active = join(dir, "runner.log");
      const runaway = join(dir, "runner.log.runaway-1.0.16-20260915T163202Z");
      const file = await open(runaway, "w", 0o600);
      try {
        await file.truncate(5.5 * 1024 * 1024 * 1024);
      } finally {
        await file.close();
      }

      assert.equal(await readRunnerLogDiagnosticText(active, 0), "");
    });
  },
);

test("readRunnerLogTail concatenates bounded existing tails and ignores missing logs", async () => {
  await withTmp(async (dir) => {
    const first = join(dir, "runner.log");
    const second = join(dir, "server-runner.log");
    await writeFile(first, `${"a".repeat(80)}first-tail`, { mode: 0o600 });
    await writeFile(second, "second-tail", { mode: 0o600 });

    const tail = await readRunnerLogTail([join(dir, "missing.log"), first, second]);
    assert.match(tail, /first-tail\nsecond-tail/);
    assert.equal(tail.includes("missing.log"), false);
  });
});
