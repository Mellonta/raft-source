import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, chmodSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  KimiDriver,
  buildKimiArgs,
  buildKimiManagedMcpConfig,
  detectKimiModels,
  resolveKimiSpawn,
  writeKimiPromptFiles,
} from "./kimi";

const driver = new KimiDriver();
const config = {
  name: "hao",
  displayName: "Hao",
  description: "runtime tester",
  model: "kimi-k2",
  runtime: "kimi",
  reasoningEffort: null,
  envVars: null,
  sessionId: null,
  serverUrl: "https://api.slock.ai",
  authToken: null,
};

test("kimi driver does not expose a runtime-control MCP config helper", () => {
  assert.equal(driver.communication.runtimeControl, "none");
  assert.equal("buildChatBridgeArgs" in driver, false);
});

test("resolveKimiSpawn bypasses cmd.exe on Windows", () => {
  const resolved = resolveKimiSpawn(["--wire", "--yolo"], {
    platform: "win32",
    execFileSyncFn: ((command: string, args?: readonly string[]) => {
      assert.equal(command, "powershell.exe");
      assert.deepEqual(args?.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
      return Buffer.from(String.raw`C:\Users\bot\.local\bin\kimi.exe` + "\r\n");
    }) as any,
  });

  assert.equal(resolved.command, String.raw`C:\Users\bot\.local\bin\kimi.exe`);
  assert.deepEqual(resolved.args, ["--wire", "--yolo"]);
  assert.equal(resolved.shell, false);
});

test("kimi managed MCP file uses the upstream remote HTTP schema", () => {
  assert.deepEqual(buildKimiManagedMcpConfig({
    name: "raftmanagedabc123",
    url: "http://127.0.0.1:1234/mcp/opaque",
  }), {
    mcpServers: {
      raftmanagedabc123: {
        url: "http://127.0.0.1:1234/mcp/opaque",
        transport: "http",
      },
    },
  });
  assert.deepEqual(buildKimiArgs({
    config: { ...config, model: "default" } as any,
    sessionId: "session-1",
    agentFilePath: "/tmp/agent.yaml",
    managedMcpConfigPath: "/tmp/private/mcp.json",
  }), [
    "--wire",
    "--yolo",
    "--agent-file", "/tmp/agent.yaml",
    "--session", "session-1",
    "--mcp-config-file", "/tmp/private/mcp.json",
  ]);
});

test("parseLine: CompactionBegin emits compaction_started", () => {
  const events = driver.parseLine(JSON.stringify({
    jsonrpc: "2.0",
    method: "event",
    params: {
      type: "CompactionBegin",
      payload: {},
    },
  }));

  assert.deepEqual(events, [{ kind: "compaction_started" }]);
});

test("parseLine: CompactionEnd emits compaction_finished", () => {
  const events = driver.parseLine(JSON.stringify({
    jsonrpc: "2.0",
    method: "event",
    params: {
      type: "CompactionEnd",
      payload: {},
    },
  }));

  assert.deepEqual(events, [{ kind: "compaction_finished" }]);
});

function withTempHome(cb: (home: string) => void) {
  const home = mkdtempSync(path.join(os.tmpdir(), "slock-kimi-"));
  try { cb(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

test("detectKimiModels returns null when config missing", () => {
  withTempHome((home) => {
    assert.equal(detectKimiModels(home), null);
  });
});

test("detectKimiModels parses [models.*] sections and default_model", () => {
  withTempHome((home) => {
    mkdirSync(path.join(home, ".kimi"));
    writeFileSync(
      path.join(home, ".kimi", "config.toml"),
      [
        `default_model = "kimi-k2"`,
        `[models.kimi-k2]`,
        `api_key = "x"`,
        `[models."kimi-latest"]`,
        `api_key = "y"`,
      ].join("\n"),
    );
    const result = detectKimiModels(home);
    assert.ok(result);
    assert.deepEqual(result!.models.map((m) => m.id).sort(), ["kimi-k2", "kimi-latest"]);
    assert.equal(result!.default, "kimi-k2");
  });
});

test("detectKimiModels returns null when no models section present", () => {
  withTempHome((home) => {
    mkdirSync(path.join(home, ".kimi"));
    writeFileSync(path.join(home, ".kimi", "config.toml"), `default_model = "x"\n`);
    assert.equal(detectKimiModels(home), null);
  });
});


// task #302: these files land in the agent workspace. Without an explicit mode
// they are created 0644 under the usual umask, while every sibling prompt
// writer is owner-only. The assertion is on the real on-disk mode, not on the
// options object, so it still fails if the call stops passing one.
test("kimi prompt and agent-config files are written owner-only (task #302)", () => {
  if (process.platform === "win32") return; // POSIX permission bits do not apply
  const dir = mkdtempSync(path.join(os.tmpdir(), "kimi-mode-"));
  try {
    const { systemPromptPath, agentFilePath } = writeKimiPromptFiles(dir, "standing prompt body", false);
    assert.equal(statSync(systemPromptPath).mode & 0o777, 0o600, "kimi system prompt file must be 0600");
    assert.equal(statSync(agentFilePath).mode & 0o777, 0o600, "kimi agent config file must be 0600");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// task #302 stock arm (XX, msg ff116b5e): the card is about EXISTING files, not
// just newly created ones. On resume the prompt write is skipped, and even for
// the agent file writeFileSync ignores `mode` when the file already exists — so
// without an explicit chmod a pre-#302 0644 file stays 0644 forever.
test("kimi prompt files already on disk at 0644 are tightened to 0600 on resume (task #302)", () => {
  if (process.platform === "win32") return; // POSIX permission bits do not apply
  const dir = mkdtempSync(path.join(os.tmpdir(), "kimi-stock-"));
  try {
    const { systemPromptPath, agentFilePath } = writeKimiPromptFiles(dir, "original prompt", false);
    // Simulate a file created before this fix.
    chmodSync(systemPromptPath, 0o644);
    chmodSync(agentFilePath, 0o644);
    assert.equal(statSync(systemPromptPath).mode & 0o777, 0o644, "precondition: stock file is 0644");

    const again = writeKimiPromptFiles(dir, "ignored on resume", true);

    assert.equal(statSync(again.systemPromptPath).mode & 0o777, 0o600, "resume must tighten the existing prompt file");
    assert.equal(statSync(again.agentFilePath).mode & 0o777, 0o600, "resume must tighten the existing agent file");
    // The resume path must still not clobber the prompt body.
    assert.equal(readFileSync(again.systemPromptPath, "utf8"), "original prompt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
