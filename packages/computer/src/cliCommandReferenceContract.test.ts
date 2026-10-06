import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { program } from "./cli";

type CommanderCommand = typeof program;

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listSourceFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function extractReferences(src: string): string[] {
  const refs: string[] = [];
  const body = stripComments(src);
  const re = /\braft-computer\s+([^\n`"']+)/g;
  for (let match = re.exec(body); match !== null; match = re.exec(body)) {
    const raw = `raft-computer ${match[1] ?? ""}`
      .replace(/[\\),.;:]+$/g, "")
      .trim();
    refs.push(raw);
  }
  return refs;
}

function optionNames(command: CommanderCommand): Set<string> {
  const opts = new Set<string>();
  for (const option of command.options) {
    if (option.long) opts.add(option.long);
  }
  return opts;
}

function commandByName(command: CommanderCommand, name: string): CommanderCommand | undefined {
  return command.commands.find((child) => child.name() === name) as CommanderCommand | undefined;
}

function resolveReference(ref: string): { command: CommanderCommand; consumed: number; tokens: string[] } {
  const tokens = ref.split(/\s+/).slice(1).map((token) => token.replace(/[\\),.;:]+$/g, ""));
  assert.ok(tokens.length > 0, `empty raft-computer reference: ${ref}`);
  const first = tokens[0];
  assert.ok(first, `empty raft-computer command: ${ref}`);
  let command = commandByName(program, first);
  assert.ok(command, `unknown raft-computer command in "${ref}"`);
  let consumed = 1;
  while (tokens[consumed] && /^[a-z][\w-]*$/.test(tokens[consumed])) {
    const child = commandByName(command, tokens[consumed]);
    if (!child) break;
    command = child;
    consumed += 1;
  }
  return { command, consumed, tokens };
}

test("user-facing raft-computer command references point at registered commands and flags", async () => {
  const srcDir = new URL(".", import.meta.url).pathname;
  const files = await listSourceFiles(srcDir);
  const failures: string[] = [];

  for (const file of files) {
    const rel = relative(srcDir, file);
    const refs = extractReferences(await readFile(file, "utf8"));
    for (const ref of refs) {
      try {
        const { command, consumed, tokens } = resolveReference(ref);
        const allowed = optionNames(command);
        for (const token of tokens.slice(consumed)) {
          const flag = token.match(/^(--[a-z][\w-]*)/)?.[1];
          if (!flag) continue;
          assert.ok(allowed.has(flag), `unknown option ${flag} for "${ref}"`);
        }
      } catch (err) {
        failures.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test("status command has zero OS-supervisor inspection or mutation calls", async () => {
  const source = await readFile(new URL("./cli.ts", import.meta.url), "utf8");
  const start = source.indexOf('.command("status")');
  const end = source.indexOf('.command("doctor")', start);
  assert.ok(start >= 0 && end > start, "status command block must remain discoverable");
  const statusBlock = source.slice(start, end);
  assert.doesNotMatch(statusBlock, /inspectOsSupervisor|mutateOsSupervisor|OS supervisor/);
});

test("doctor exposes the explicit private unread/Activity dump option without a JSON stdout mode", () => {
  const doctor = commandByName(program, "doctor");
  assert.ok(doctor);
  assert.ok(optionNames(doctor).has("--unread-activity-dump"));
  assert.ok(!optionNames(doctor).has("--json"));
});

test("doctor rejects migration details with an unread/Activity dump before creating the target", async () => {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-doctor-option-conflict-"));
  const outputPath = join(home, "must-not-exist.json");
  const previousExitCode = process.exitCode;
  const previousStderrWrite = process.stderr.write;
  const previousSlockHome = process.env.SLOCK_HOME;
  const previousRaftHome = process.env.RAFT_HOME;
  let stderr = "";
  process.exitCode = undefined;
  process.env.SLOCK_HOME = home;
  process.env.RAFT_HOME = home;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;

  try {
    await program.parseAsync([
      "node",
      "raft-computer",
      "doctor",
      "--migration-details",
      "--unread-activity-dump",
      outputPath,
    ]);
    assert.equal(process.exitCode, 1);
    assert.match(stderr, /What happened \(INVALID_ARGUMENT\)/);
    await assert.rejects(stat(outputPath), { code: "ENOENT" });
  } finally {
    process.stderr.write = previousStderrWrite;
    process.exitCode = previousExitCode;
    if (previousSlockHome === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = previousSlockHome;
    if (previousRaftHome === undefined) delete process.env.RAFT_HOME;
    else process.env.RAFT_HOME = previousRaftHome;
    await rm(home, { recursive: true, force: true });
  }
});
