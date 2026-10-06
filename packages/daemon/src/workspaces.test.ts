import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {
  deleteWorkspaceDirectory,
  resolveWorkspaceDirectoryPath,
  scanWorkspaceDirectories,
} from "./workspaces";

test("scanWorkspaceDirectories summarizes workspace directories recursively", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daemon-workspaces-"));
  try {
    const firstDir = path.join(root, "agent-one");
    const secondDir = path.join(root, "agent-two");
    await mkdir(firstDir);
    await mkdir(secondDir);
    await writeFile(path.join(firstDir, "notes.md"), "hello");
    await writeFile(path.join(firstDir, "config.json"), "{\"ok\":true}");
    await mkdir(path.join(firstDir, "nested"));
    await writeFile(path.join(firstDir, "nested", "child.txt"), "nested");
    await writeFile(path.join(secondDir, "README.txt"), "x");

    const directories = await scanWorkspaceDirectories(root);
    const first = directories.find((entry) => entry.directoryName === "agent-one");
    const second = directories.find((entry) => entry.directoryName === "agent-two");

    assert.ok(first);
    assert.equal(first.fileCount, 3);
    assert.equal(
      first.totalSizeBytes,
      Buffer.byteLength("hello") + Buffer.byteLength("{\"ok\":true}") + Buffer.byteLength("nested"),
    );
    assert.notEqual(first.lastModified, new Date(0).toISOString());

    assert.ok(second);
    assert.equal(second.fileCount, 1);
    assert.equal(second.totalSizeBytes, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveWorkspaceDirectoryPath rejects path traversal", () => {
  assert.equal(resolveWorkspaceDirectoryPath("/tmp/daemon", "agent-1"), path.join("/tmp/daemon", "agent-1"));
  assert.equal(resolveWorkspaceDirectoryPath("/tmp/daemon", "../agent-1"), null);
  assert.equal(resolveWorkspaceDirectoryPath("/tmp/daemon", "nested/agent-1"), null);
});

test("deleteWorkspaceDirectory removes only valid workspace directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daemon-workspaces-delete-"));
  try {
    const targetDir = path.join(root, "agent-delete");
    await mkdir(targetDir);
    await writeFile(path.join(targetDir, "notes.md"), "delete-me");

    assert.equal(await deleteWorkspaceDirectory(root, "agent-delete"), true);
    assert.deepEqual(await scanWorkspaceDirectories(root), []);
    assert.equal(await deleteWorkspaceDirectory(root, "../outside"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The blocklist that used to guard this rejected "/", "\\" and ".." -- every traversal
// string and nothing else. "." and "" are neither traversal nor a child: path.join
// collapses both to dataDir itself, so a request naming ONE workspace deleted the root
// holding EVERY agent workspace on the machine, and returned the same success as an
// ordinary delete.
//
// These cases are why the guard is now a containment assertion rather than a longer
// blocklist. A blocklist can only reject the inputs its author thought of, and here the
// failure mode is silent, total and irreversible.
test("resolveWorkspaceDirectoryPath rejects names that resolve to the root itself", () => {
  assert.equal(resolveWorkspaceDirectoryPath("/tmp/daemon", "."), null);
  assert.equal(resolveWorkspaceDirectoryPath("/tmp/daemon", ""), null);
  assert.equal(resolveWorkspaceDirectoryPath("/tmp/daemon", "./"), null);
  assert.equal(resolveWorkspaceDirectoryPath("/tmp/daemon", "agent-1/.."), null);
  // Must not over-reject: these are still ordinary children.
  assert.equal(resolveWorkspaceDirectoryPath("/tmp/daemon", "agent-1"), path.join("/tmp/daemon", "agent-1"));
  assert.equal(resolveWorkspaceDirectoryPath("/tmp/daemon", ".hidden-agent"), path.join("/tmp/daemon", ".hidden-agent"));
  // Deliberate, and the one behaviour the containment guard widens: the old blocklist
  // rejected this purely because it contains "/". It names the same directory as
  // "agent-1" and resolves one level below the root, so it is accepted now. Pinned here
  // so the change is a decision on the record rather than a side effect.
  assert.equal(resolveWorkspaceDirectoryPath("/tmp/daemon", "agent-1/"), path.join("/tmp/daemon", "agent-1"));
});

test("deleteWorkspaceDirectory leaves the root intact when asked to delete '.'", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daemon-workspaces-root-"));
  try {
    const targetDir = path.join(root, "agent-keep");
    await mkdir(targetDir);
    await writeFile(path.join(targetDir, "notes.md"), "must survive");

    assert.equal(await deleteWorkspaceDirectory(root, "."), false);
    assert.equal(await deleteWorkspaceDirectory(root, ""), false);

    // The assertion with teeth. `false` alone is not the property that matters --
    // what matters is that the root and its contents are still there afterwards.
    assert.deepEqual(
      (await scanWorkspaceDirectories(root)).map((d) => d.directoryName),
      ["agent-keep"],
      "deleting '.' must not remove every workspace on the machine",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
