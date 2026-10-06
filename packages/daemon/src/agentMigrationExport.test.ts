import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listAgentMigrationWorkspace,
  normalizeAgentMigrationSymlinkTarget,
  summarizeAgentMigrationTransfer,
} from "./agentMigrationExport";

function tempRoot(): string {
  return path.join(os.tmpdir(), `agent-migration-export-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

async function listWorkspace(workspacePath: string) {
  const listed: string[] = [];
  const listing = await listAgentMigrationWorkspace({
    workspacePath,
    onEntry: (relativePath) => {
      listed.push(relativePath);
    },
  });
  return { listed, ...listing };
}

function summarize(excluded: Awaited<ReturnType<typeof listWorkspace>>, input: {
  includedFileCount?: number;
  includedBytes?: number;
  memoryMdPresent?: boolean;
  notesPresent?: boolean;
} = {}) {
  return summarizeAgentMigrationTransfer({
    includedFileCount: input.includedFileCount ?? excluded.listed.length,
    includedBytes: input.includedBytes ?? 0,
    memoryMdPresent: input.memoryMdPresent ?? false,
    notesPresent: input.notesPresent ?? false,
    excludedRegenerable: excluded.excludedRegenerable,
    excludedIgnored: excluded.excludedIgnored,
  });
}

test("migration export includes unknown workspace files by default and excludes only regenerable dirs", async () => {
  const root = tempRoot();
  const slockHome = path.join(root, ".slock");
  const workspace = path.join(slockHome, "agents", "agent-1");
  try {
    mkdirSync(path.join(workspace, "node_modules", "leftpad"), { recursive: true });
    mkdirSync(path.join(workspace, "target"), { recursive: true });
    mkdirSync(path.join(workspace, ".venv"), { recursive: true });
    mkdirSync(path.join(workspace, "dist"), { recursive: true });
    mkdirSync(path.join(workspace, "__pycache__"), { recursive: true });
    mkdirSync(path.join(workspace, "build"), { recursive: true });
    writeFileSync(path.join(workspace, "README.md"), "important notes\n");
    writeFileSync(path.join(workspace, ".gitignore"), ".env\nbuild\n");
    writeFileSync(path.join(workspace, ".env"), "OPENAI_API_KEY=sk-test-secret\nNORMAL=value\n");
    writeFileSync(path.join(workspace, "node_modules", "leftpad", "index.js"), "regenerated\n");
    writeFileSync(path.join(workspace, "target", "artifact"), "regenerated\n");
    writeFileSync(path.join(workspace, ".venv", "pyvenv.cfg"), "regenerated\n");
    writeFileSync(path.join(workspace, "dist", "bundle.js"), "regenerated\n");
    writeFileSync(path.join(workspace, "__pycache__", "module.pyc"), "regenerated\n");
    writeFileSync(path.join(workspace, "build", "artifact.txt"), "not on daemon whitelist\n");

    const listing = await listWorkspace(workspace);

    assert.deepEqual([...listing.listed].sort((x, y) => x.localeCompare(y)), [
      ".env",
      ".gitignore",
      "build/artifact.txt",
      "README.md",
    ]);
    assert.deepEqual(listing.excludedRegenerable.map((entry) => entry.path), [
      "__pycache__",
      ".venv",
      "dist",
      "node_modules",
      "target",
    ]);
    assert.deepEqual(summarize(listing).excludedRegenerableByCategory, {
      thirdPartyDependencies: 2,
      caches: 1,
      buildArtifacts: 2,
      otherRegenerable: 0,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unreadable directories are recorded as unreachable by the workspace listing", async () => {
  const root = tempRoot();
  const slockHome = path.join(root, ".slock");
  const workspace = path.join(slockHome, "agents", "agent-unreachable");
  const unreadableDir = path.join(workspace, "private-dir");
  try {
    mkdirSync(unreadableDir, { recursive: true });
    writeFileSync(path.join(workspace, "notes.md"), "ok\n");
    chmodSync(unreadableDir, 0o000);

    const listed: string[] = [];
    const listing = await listAgentMigrationWorkspace({
      workspacePath: workspace,
      onEntry: (relativePath) => {
        listed.push(relativePath);
      },
    });

    assert.deepEqual(listed, ["notes.md"]);
    assert.deepEqual(listing.unreachable.map((entry) => ({
      path: entry.path,
      reason: entry.reason,
    })), [
      { path: "private-dir", reason: "read_error" },
    ]);
  } finally {
    try {
      chmodSync(unreadableDir, 0o700);
    } catch {
      // Directory may not exist if setup failed early.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("symlink target normalization rejects foreign roots, NUL, and workspace escape on every host", () => {
  for (const target of [
    "/Users/alice/source-local-secret",
    "C:\\Users\\alice\\source-local-secret",
    "C:source-local-secret",
    "\\\\server\\share\\source-local-secret",
    "target\0secret",
    "../../source-local-secret",
  ]) {
    assert.throws(
      () => normalizeAgentMigrationSymlinkTarget("nested/link", target),
      /MIGRATION_OBJECT_STORE_UNSAFE_LINK/,
      target,
    );
  }
  assert.equal(
    normalizeAgentMigrationSymlinkTarget("nested/link", "peer\\target-file"),
    "peer/target-file",
  );
  assert.equal(
    normalizeAgentMigrationSymlinkTarget("nested/link", "../target-file"),
    "../target-file",
  );
});

test("common framework build outputs and tool caches are summarized as regenerable, by category", () => {
  const summary = summarizeAgentMigrationTransfer({
    includedFileCount: 0,
    includedBytes: 0,
    memoryMdPresent: false,
    notesPresent: false,
    excludedRegenerable: [
      { path: "web/.next" },
      { path: "py/.mypy_cache" },
      { path: "py/.pytest_cache" },
      { path: "infra/.terraform" },
      { path: "app/.turbo" },
    ] as never,
  });
  assert.deepEqual(summary.excludedRegenerableByCategory, {
    thirdPartyDependencies: 1,
    caches: 3,
    buildArtifacts: 1,
    otherRegenerable: 0,
  });
});

test(".raftmigrateignore excludes listed paths with their size, but never MEMORY.md or the ignore file", async () => {
  const root = tempRoot();
  const slockHome = path.join(root, ".slock");
  const workspace = path.join(slockHome, "agents", "agent-ignore");
  try {
    mkdirSync(path.join(workspace, "datasets", "raw"), { recursive: true });
    mkdirSync(path.join(workspace, "notes"), { recursive: true });
    writeFileSync(path.join(workspace, "MEMORY.md"), "memory\n");
    writeFileSync(path.join(workspace, "notes", "domain.md"), "domain\n");
    writeFileSync(path.join(workspace, "datasets", "a.csv"), "x".repeat(300));
    writeFileSync(path.join(workspace, "datasets", "raw", "b.csv"), "y".repeat(700));
    writeFileSync(path.join(workspace, "cache.sqlite"), "z".repeat(50));
    writeFileSync(path.join(workspace, "keep.txt"), "keep\n");
    writeFileSync(path.join(workspace, ".raftmigrateignore"), [
      "# re-downloadable",
      "./datasets/",
      "cache.sqlite",
      "MEMORY.md",
      ".raftmigrateignore",
      "*.log",
      "../outside",
      "",
    ].join("\n"));

    const listing = await listWorkspace(workspace);
    assert.deepEqual([...listing.listed].sort(), [".raftmigrateignore", "MEMORY.md", "keep.txt", "notes/domain.md"]);
    assert.deepEqual(listing.excludedIgnored, [
      { path: "cache.sqlite", reason: "raftmigrateignore", fileCount: 1, sizeBytes: 50 },
      { path: "datasets", reason: "raftmigrateignore", fileCount: 2, sizeBytes: 1000 },
    ]);

    const summary = summarize(listing);
    assert.deepEqual(summary.excludedIgnored, {
      count: 2,
      fileCount: 3,
      bytes: 1050,
      largest: [{ path: "datasets", bytes: 1000 }, { path: "cache.sqlite", bytes: 50 }],
    });
    assert.equal(JSON.stringify(summary).includes(workspace), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a summary without ignored paths omits excludedIgnored so older servers still accept it", async () => {
  const root = tempRoot();
  const slockHome = path.join(root, ".slock");
  const workspace = path.join(slockHome, "agents", "agent-no-ignore");
  try {
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "MEMORY.md"), "memory\n");
    const listing = await listWorkspace(workspace);
    assert.deepEqual(listing.excludedIgnored, []);
    assert.equal("excludedIgnored" in summarize(listing), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
