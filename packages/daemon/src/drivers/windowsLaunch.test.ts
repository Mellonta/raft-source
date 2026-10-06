import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeExecutableNotFoundError } from "../spawnFailureErrors";
import { resolveRuntimeLaunch, resolveWindowsDirectLaunch, windowsShimTargets, type WindowsLaunchDeps } from "./windowsLaunch";

// Wrapper contents as installed on a Windows runner (npm 10) or as written by
// the pnpm and scoop shim generators.
const NPM_JS_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  "IF EXIST \"%dp0%\\node.exe\" (",
  "  SET \"_prog=%dp0%\\node.exe\"",
  ") ELSE (",
  "  SET \"_prog=node\"",
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@github\\copilot\\npm-loader.js\" %*",
].join("\r\n");

const NPM_EXE_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*",
].join("\r\n");

const PNPM_JS_SHIM = [
  "@SETLOCAL",
  "@IF NOT DEFINED NODE_PATH (",
  "  @SET \"NODE_PATH=C:\\Users\\tester\\AppData\\Local\\pnpm\\global\\5\\node_modules\\.pnpm\\node_modules\"",
  ") ELSE (",
  "  @SET \"NODE_PATH=%NODE_PATH%;C:\\Users\\tester\\AppData\\Local\\pnpm\\global\\5\\node_modules\\.pnpm\\node_modules\"",
  ")",
  "@IF EXIST \"%~dp0\\node.exe\" (",
  "  \"%~dp0\\node.exe\"  \"%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js\" %*",
  ") ELSE (",
  "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
  "  node  \"%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js\" %*",
  ")",
].join("\r\n");

const SCOOP_CMD_SHIM = [
  "@rem C:\\Users\\tester\\scoop\\persist\\nodejs-lts\\bin\\copilot.cmd",
  "@\"C:\\Users\\tester\\scoop\\persist\\nodejs-lts\\bin\\copilot.cmd\" %*",
].join("\r\n");

const POWERSHELL_HANDOFF_SHIM = [
  "@echo off",
  "setlocal enabledelayedexpansion",
  "set \"SCRIPT_DIR=%~dp0\"",
  "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%SCRIPT_DIR%\\tool.ps1\" %*",
].join("\r\n");

// Characters cmd.exe would interpret, split on, or stop at.
const SPECIAL_CHARS_PROMPT = "line one\r\nline two & a | b > c < d ^ \"quoted\" %PATH% !VAR! (paren)";

const NPM_BIN = "C:\\Users\\tester\\AppData\\Roaming\\npm";
const PNPM_BIN = "C:\\Users\\tester\\AppData\\Local\\pnpm";
const SCOOP_SHIMS = "C:\\Users\\tester\\scoop\\shims";
const SCOOP_NODE_BIN = "C:\\Users\\tester\\scoop\\persist\\nodejs-lts\\bin";
const DAEMON_NODE = "C:\\Program Files\\nodejs\\node.exe";

function windowsDeps(input: {
  files: Record<string, string>;
  onPath?: Record<string, string>;
  host?: "node" | "sea";
}): WindowsLaunchDeps {
  const files = new Map(Object.entries(input.files).map(([file, content]) => [file.toLowerCase(), content]));
  return {
    platform: "win32",
    env: { Path: "C:\\Windows\\System32" },
    execPath: DAEMON_NODE,
    execIsElectron: false,
    execIsSea: input.host === "sea",
    hasNodeRuntime: input.host !== "sea",
    windowsEnvironmentReaderFn: () => null,
    existsSyncFn: (file) => files.has(file.toLowerCase()),
    readFileSyncFn: (file) => {
      const content = files.get(file.toLowerCase());
      if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return content;
    },
    execFileSyncFn: ((command: string, args: readonly string[]) => {
      assert.equal(command, "powershell.exe");
      const name = args[args.length - 1]!;
      const resolved = input.onPath?.[name];
      if (!resolved) throw new Error(`not found: ${name}`);
      return Buffer.from(`${resolved}\r\n`);
    }) as unknown as WindowsLaunchDeps["execFileSyncFn"],
  };
}

function launchFailureReason(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof RuntimeExecutableNotFoundError, `expected RuntimeExecutableNotFoundError, got ${String(error)}`);
    return error.reason;
  }
  assert.fail("expected the launch to be rejected");
}

test("off Windows the command name and argv pass through unchanged, without a shell", () => {
  const launch = resolveRuntimeLaunch("copilot", "copilot", ["-p", SPECIAL_CHARS_PROMPT], { platform: "linux" });
  assert.deepEqual(launch, { command: "copilot", args: ["-p", SPECIAL_CHARS_PROMPT], shell: false });
});

test("npm global .cmd wrapper runs its JavaScript entry with node, argv intact", () => {
  const entry = `${NPM_BIN}\\node_modules\\@github\\copilot\\npm-loader.js`;
  const deps = windowsDeps({
    files: { [`${NPM_BIN}\\copilot.cmd`]: NPM_JS_SHIM, [entry]: "" },
    onPath: { copilot: `${NPM_BIN}\\copilot.cmd` },
  });
  const launch = resolveRuntimeLaunch("copilot", "copilot", ["-p", SPECIAL_CHARS_PROMPT, "--model", "gpt-5"], deps);
  assert.deepEqual(launch, {
    command: DAEMON_NODE,
    args: [entry, "-p", SPECIAL_CHARS_PROMPT, "--model", "gpt-5"],
    env: deps.env,
    shell: false,
  });
});

test("npm global .cmd wrapper around a native .exe runs the .exe directly", () => {
  const exe = `${NPM_BIN}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
  const deps = windowsDeps({ files: { [`${NPM_BIN}\\claude.cmd`]: NPM_EXE_SHIM, [exe]: "" } });
  const launch = resolveWindowsDirectLaunch("claude", `${NPM_BIN}\\claude.cmd`, ["--settings", "{\"fastMode\":true}"], deps);
  assert.deepEqual(launch, { command: exe, args: ["--settings", "{\"fastMode\":true}"], shell: false });
});

test("pnpm global .cmd wrapper resolves its %~dp0-relative entry", () => {
  const entry = `${PNPM_BIN}\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js`;
  const deps = windowsDeps({ files: { [`${PNPM_BIN}\\codex.cmd`]: PNPM_JS_SHIM, [entry]: "" } });
  assert.deepEqual(windowsShimTargets(`${PNPM_BIN}\\codex.cmd`, deps), [entry]);
  const launch = resolveWindowsDirectLaunch("codex", `${PNPM_BIN}\\codex.cmd`, ["app-server"], deps);
  assert.equal(launch.command, DAEMON_NODE);
  assert.deepEqual(launch.args, [entry, "app-server"]);
  assert.equal(launch.shell, false);
});

test("scoop .cmd shim pointing at another wrapper is followed to the real entry", () => {
  const entry = `${SCOOP_NODE_BIN}\\node_modules\\@github\\copilot\\npm-loader.js`;
  const deps = windowsDeps({
    files: {
      [`${SCOOP_SHIMS}\\copilot.cmd`]: SCOOP_CMD_SHIM,
      [`${SCOOP_NODE_BIN}\\copilot.cmd`]: NPM_JS_SHIM,
      [entry]: "",
    },
  });
  const launch = resolveWindowsDirectLaunch("copilot", `${SCOOP_SHIMS}\\copilot.cmd`, ["-p", SPECIAL_CHARS_PROMPT], deps);
  assert.equal(launch.command, DAEMON_NODE);
  assert.deepEqual(launch.args, [entry, "-p", SPECIAL_CHARS_PROMPT]);
});

test("a native .exe (including a scoop shim.exe) is launched as is", () => {
  const exe = `${SCOOP_SHIMS}\\grok.exe`;
  const launch = resolveWindowsDirectLaunch("grok", exe, ["agent", SPECIAL_CHARS_PROMPT], windowsDeps({ files: { [exe]: "" } }));
  assert.deepEqual(launch, { command: exe, args: ["agent", SPECIAL_CHARS_PROMPT], shell: false });
});

test("a single-file daemon host uses the node.exe the wrapper would have used", () => {
  const entry = `${NPM_BIN}\\node_modules\\@github\\copilot\\npm-loader.js`;
  const pathNode = "C:\\nvm4w\\nodejs\\node.exe";
  const sibling = windowsDeps({
    host: "sea",
    files: { [`${NPM_BIN}\\copilot.cmd`]: NPM_JS_SHIM, [entry]: "", [`${NPM_BIN}\\node.exe`]: "" },
  });
  assert.equal(resolveWindowsDirectLaunch("copilot", `${NPM_BIN}\\copilot.cmd`, [], sibling).command, `${NPM_BIN}\\node.exe`);

  const onPath = windowsDeps({
    host: "sea",
    files: { [`${NPM_BIN}\\copilot.cmd`]: NPM_JS_SHIM, [entry]: "" },
    onPath: { node: pathNode },
  });
  const launch = resolveWindowsDirectLaunch("copilot", `${NPM_BIN}\\copilot.cmd`, ["-p", "x"], onPath);
  assert.deepEqual(launch, { command: pathNode, args: [entry, "-p", "x"], shell: false });
});

test("unresolvable launches fail with a typed reason instead of falling back to cmd.exe", () => {
  const entry = `${NPM_BIN}\\node_modules\\@github\\copilot\\npm-loader.js`;
  assert.equal(
    launchFailureReason(() => resolveRuntimeLaunch("copilot", "copilot", [], windowsDeps({ files: {} }))),
    "not_on_path",
  );
  assert.equal(
    launchFailureReason(() => resolveWindowsDirectLaunch(
      "tool",
      "C:\\tools\\tool.cmd",
      [],
      windowsDeps({ files: { "C:\\tools\\tool.cmd": POWERSHELL_HANDOFF_SHIM } }),
    )),
    "batch_target_unresolved",
  );
  assert.equal(
    launchFailureReason(() => resolveWindowsDirectLaunch(
      "copilot",
      `${NPM_BIN}\\copilot.cmd`,
      [],
      windowsDeps({ files: { [`${NPM_BIN}\\copilot.cmd`]: NPM_JS_SHIM } }),
    )),
    "batch_target_unresolved",
    "a wrapper whose entry is missing is not launched",
  );
  assert.equal(
    launchFailureReason(() => resolveWindowsDirectLaunch(
      "copilot",
      `${NPM_BIN}\\copilot.cmd`,
      [],
      windowsDeps({ host: "sea", files: { [`${NPM_BIN}\\copilot.cmd`]: NPM_JS_SHIM, [entry]: "" } }),
    )),
    "node_unavailable",
  );
});

test("the unresolved-wrapper message tells the user what to do", () => {
  try {
    resolveWindowsDirectLaunch("tool", "C:\\tools\\tool.cmd", [], windowsDeps({ files: { "C:\\tools\\tool.cmd": POWERSHELL_HANDOFF_SHIM } }));
    assert.fail("expected rejection");
  } catch (error) {
    assert.ok(error instanceof RuntimeExecutableNotFoundError);
    assert.match(error.message, /tool\.cmd/);
    assert.match(error.message, /Reinstall tool with npm|native \.exe/);
    assert.doesNotMatch(error.message, /C:\\tools/, "the message names the wrapper, not the user's directory layout");
  }
});

test("wrapper parsing ignores node.exe, %variable% paths and the wrapper itself", () => {
  const deps = windowsDeps({ files: { [`${NPM_BIN}\\copilot.cmd`]: NPM_JS_SHIM } });
  assert.deepEqual(windowsShimTargets(`${NPM_BIN}\\copilot.cmd`, deps), [
    `${NPM_BIN}\\node_modules\\@github\\copilot\\npm-loader.js`,
  ]);
  const selfRef = windowsDeps({ files: { "C:\\x\\a.cmd": "@\"C:\\x\\a.cmd\" %*" } });
  assert.deepEqual(windowsShimTargets("C:\\x\\a.cmd", selfRef), []);
});

test("no daemon runtime launch is configured to go through a shell", () => {
  const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      readFileSync(full, "utf8").split("\n").forEach((line, index) => {
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
        if (/\bshell:\s*(?:true\b|[^,}\n]*(?:win32|platform|requiresWindowsShell))/.test(line)) {
          offenders.push(`${path.relative(srcDir, full)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
  };
  walk(srcDir);
  assert.deepEqual(offenders, []);
});
