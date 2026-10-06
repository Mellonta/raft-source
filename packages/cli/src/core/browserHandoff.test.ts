import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { browserOpenCommand, canInstallEnterToOpenUrl, installEnterToOpenUrl, openUrlInBrowser } from "./browserHandoff";

test("installEnterToOpenUrl opens the URL on Enter and only once", () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  input.isTTY = true;
  const opened: string[] = [];

  installEnterToOpenUrl({
    input,
    url: "https://app.raft.build/login/device?user_code=ABCD-1234",
    openUrl: (url) => opened.push(url),
  });

  input.write("x");
  assert.deepEqual(opened, []);

  input.write("\n");
  input.write("\n");
  assert.deepEqual(opened, ["https://app.raft.build/login/device?user_code=ABCD-1234"]);
});

test("canInstallEnterToOpenUrl requires TTY stdin", () => {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  assert.equal(canInstallEnterToOpenUrl(input), false);
  input.isTTY = true;
  assert.equal(canInstallEnterToOpenUrl(input), true);
});

test("browserOpenCommand opens http(s) URLs on Windows without going through cmd", () => {
  const url = "https://app.raft.build/login/device?user_code=ABCD-1234&next=a^b|c";
  const opener = browserOpenCommand(url, "win32");
  assert.deepEqual(opener, {
    command: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", "https://app.raft.build/login/device?user_code=ABCD-1234&next=a^b|c"],
  });
  for (const platform of ["win32", "darwin", "linux"] as const) {
    const command = browserOpenCommand(url, platform);
    assert.ok(command);
    assert.notEqual(command.command.toLowerCase(), "cmd");
    assert.notEqual(command.command.toLowerCase(), "cmd.exe");
    // The URL is one argv entry, never split or joined into a shell string.
    assert.equal(command.args.at(-1), new URL(url).href);
  }
  assert.deepEqual(browserOpenCommand("http://localhost:3000/login", "darwin"), { command: "open", args: ["http://localhost:3000/login"] });
});

test("browserOpenCommand refuses anything that is not an http(s) URL", () => {
  for (const url of [
    "file:///C:/Windows/System32/calc.exe",
    "javascript:alert(1)",
    "ms-settings:",
    "C:\\Windows\\System32\\calc.exe",
    "calc.exe & echo",
    "\" & calc & \"",
    "",
  ]) {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      assert.equal(browserOpenCommand(url, platform), null, `${platform} ${url}`);
    }
  }
});

test("browserOpenCommand normalizes spaces and quotes out of the URL it passes on", () => {
  const opener = browserOpenCommand("https://app.raft.build/a b?q=\"x y\"", "win32");
  assert.ok(opener);
  assert.equal(opener.args[1], "https://app.raft.build/a%20b?q=%22x%20y%22");
});

test("openUrlInBrowser does not spawn anything for a non-http(s) URL", () => {
  const spawned: unknown[] = [];
  const fakeSpawn = ((...args: unknown[]) => {
    spawned.push(args);
    return { on() {}, unref() {} };
  }) as unknown as Parameters<typeof openUrlInBrowser>[1];
  openUrlInBrowser("file:///etc/passwd", fakeSpawn);
  openUrlInBrowser("not a url & calc", fakeSpawn);
  assert.equal(spawned.length, 0);
  openUrlInBrowser("https://app.raft.build/login", fakeSpawn);
  assert.equal(spawned.length, 1);
});
