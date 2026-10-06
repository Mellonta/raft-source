import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { profileVitestArgs } from "./profileVitestCommand";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VITEST_CLI = path.join(SERVER_DIR, "node_modules", "vitest", "vitest.mjs");

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

test(
  "profile reporter exposes a completed file before a blocked sibling is released",
  { skip: process.platform === "win32", timeout: 10_000 },
  async () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "server-profile-progress-"));
    const quickFile = path.join(fixtureRoot, "quick.test.ts");
    const stalledFile = path.join(fixtureRoot, "stalled.test.ts");
    const startedFile = path.join(fixtureRoot, "stalled-test-started");
    const releaseFile = path.join(fixtureRoot, "release-stalled-test");
    const outputPath = path.join(fixtureRoot, "report.json");
    symlinkSync(path.join(SERVER_DIR, "node_modules"), path.join(fixtureRoot, "node_modules"), "dir");
    writeFileSync(quickFile, [
      'import { existsSync } from "node:fs";',
      'import { test } from "vitest";',
      `test("quick", async () => { while (!existsSync(${JSON.stringify(startedFile)})) await new Promise((resolve) => setTimeout(resolve, 20)); }, 20_000);`,
      "",
    ].join("\n"));
    writeFileSync(
      stalledFile,
      [
        'import { existsSync, writeFileSync } from "node:fs";',
        'import { test } from "vitest";',
        `test("stalled", async () => { writeFileSync(${JSON.stringify(startedFile)}, "started\\n"); while (!existsSync(${JSON.stringify(releaseFile)})) await new Promise((resolve) => setTimeout(resolve, 20)); }, 20_000);`,
        "",
      ].join("\n"),
    );

    const child = spawn(process.execPath, [
      ...profileVitestArgs(VITEST_CLI, [quickFile, stalledFile], outputPath),
      "--root",
      fixtureRoot,
      "--maxWorkers=2",
      "--no-color",
    ], {
      cwd: fixtureRoot,
      env: { ...process.env, CI: "true", TZ: "Asia/Singapore" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`No incremental file progress. Output:\n${output}`)), 5_000);
        const inspect = (chunk: string) => {
          output += chunk;
          if (!output.includes("quick.test.ts")) return;
          clearTimeout(timeout);
          assert.equal(child.exitCode, null, "quick-file progress must precede process exit");
          assert.equal(child.signalCode, null, "quick-file progress must precede process termination");
          resolve();
        };
        child.stdout?.on("data", inspect);
        child.stderr?.on("data", inspect);
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once("exit", (code, signal) => {
          if (output.includes("quick.test.ts")) return;
          clearTimeout(timeout);
          reject(new Error(`Vitest exited before incremental progress (code=${String(code)} signal=${String(signal)}):\n${output}`));
        });
      });
      writeFileSync(releaseFile, "release\n");
      const exit = child.exitCode !== null || child.signalCode !== null
        ? { code: child.exitCode, signal: child.signalCode }
        : await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`Vitest did not exit after fixture release:\n${output}`)), 5_000);
            child.once("exit", (code, signal) => {
              clearTimeout(timeout);
              resolve({ code, signal });
            });
          });
      assert.deepEqual(exit, { code: 0, signal: null });
      const report = JSON.parse(readFileSync(outputPath, "utf8")) as {
        testResults?: Array<{ name?: string; status?: string; startTime?: number; endTime?: number }>;
      };
      assert.equal(report.testResults?.length, 2, "the same completed run must retain both JSON timings");
      assert.ok(report.testResults?.every((result) => result.status === "passed"));
      assert.deepEqual(
        report.testResults?.map((result) => path.basename(result.name ?? "")).sort(),
        ["quick.test.ts", "stalled.test.ts"],
      );
      assert.ok(report.testResults?.every((result) =>
        Number.isFinite(result.startTime)
        && Number.isFinite(result.endTime)
        && result.endTime! >= result.startTime!
      ));
    } finally {
      await stopChild(child);
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  },
);
