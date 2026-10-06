import assert from "node:assert/strict";
import {
  AgentMigrationObjectStoreEntryCountLimitError,
  assertAgentMigrationObjectStoreEntryLimit,
  largestWorkspaceEntryCounts,
} from "./agentMigrationObjectStoreBundle";
import { normalizeAgentMigrationWorkspaceRelativePath } from "./agentMigrationWorkspacePath";

test("entry-count producer uses a strict 250,000-entry boundary and bounded recovery wire", () => {
  const entry = {
    kind: "file" as const,
    source: "workspace" as const,
    bundlePath: "workspace/src/index.ts",
    workspaceRelativePath: "src/index.ts",
    sizeBytes: 1,
  };
  assert.doesNotThrow(() => assertAgentMigrationObjectStoreEntryLimit(Array(249_999).fill(entry)));
  assert.doesNotThrow(() => assertAgentMigrationObjectStoreEntryLimit(Array(250_000).fill(entry)));

  assert.throws(
    () => assertAgentMigrationObjectStoreEntryLimit(Array(250_001).fill(entry)),
    (error: unknown) => {
      assert.ok(error instanceof AgentMigrationObjectStoreEntryCountLimitError);
      assert.equal(error.entryCount, 250_001);
      assert.equal(error.maxEntries, 250_000);
      assert.equal(
        error.message,
        "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED:entryCount=250001:maxEntries=250000:topPathCounts=src%2F,250001",
      );
      assert.ok(error.message.length < 500);
      return true;
    },
  );
});

test("entry-count limit adds entries the export walk only counted", () => {
  const entry = {
    kind: "file" as const,
    source: "workspace" as const,
    bundlePath: "workspace/src/index.ts",
    workspaceRelativePath: "src/index.ts",
    sizeBytes: 1,
  };
  const overflow = { entryCount: 3, countByTopLevelPath: new Map([["repos/", 2], [".env", 1]]) };
  assert.doesNotThrow(() => assertAgentMigrationObjectStoreEntryLimit(Array(3).fill(entry), 6, overflow));
  assert.throws(
    () => assertAgentMigrationObjectStoreEntryLimit(Array(3).fill(entry), 5, overflow),
    (error: unknown) => {
      assert.ok(error instanceof AgentMigrationObjectStoreEntryCountLimitError);
      assert.equal(
        error.message,
        "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED:entryCount=6:maxEntries=5:topPathCounts=src%2F,3;repos%2F,2;other%2F,1",
      );
      return true;
    },
  );
});

test("entry-count recovery wire redacts secret-shaped paths and bounds the top-path list", () => {
  const files = [
    ...Array(7).fill({
      kind: "file" as const,
      source: "workspace" as const,
      bundlePath: "workspace/.env.production",
      workspaceRelativePath: ".env.production",
      sizeBytes: 1,
    }),
    ...Array(6).fill({
      kind: "file" as const,
      source: "workspace" as const,
      bundlePath: "workspace/api-key-cache/value",
      workspaceRelativePath: "api-key-cache/value",
      sizeBytes: 1,
    }),
    ...Array(5).fill({
      kind: "file" as const,
      source: "workspace" as const,
      bundlePath: "workspace/src/index.ts",
      workspaceRelativePath: "src/index.ts",
      sizeBytes: 1,
    }),
    ...Array(4).fill({
      kind: "file" as const,
      source: "workspace" as const,
      bundlePath: "workspace/.git/config",
      workspaceRelativePath: ".git/config",
      sizeBytes: 1,
    }),
    ...Array(3).fill({
      kind: "file" as const,
      source: "workspace" as const,
      bundlePath: "workspace/docs/readme.md",
      workspaceRelativePath: "docs/readme.md",
      sizeBytes: 1,
    }),
  ];
  const error = new AgentMigrationObjectStoreEntryCountLimitError(
    250_001,
    250_000,
    largestWorkspaceEntryCounts({ files }),
  );

  assert.match(error.message, /:topPathCounts=other%2F,13;src%2F,5;.git%2F,4$/);
  assert.doesNotMatch(error.message, /\.env|api-key|secret|token|credential/i);
  assert.doesNotMatch(error.message, /\/Users\/|\\Users\\|agents\/agent-/);
  assert.equal(error.message.split(";").length, 3);
  assert.ok(error.message.length < 500);
});

test("workspace-relative path normalization rejects host-independent unsafe paths", () => {
  const unsafePaths = [
    "",
    ".",
    "./",
    "/posix-absolute.txt",
    "C:\\windows-absolute.txt",
    "C:/windows-absolute.txt",
    "C:drive-relative.txt",
    "\\\\server\\share\\unc.txt",
    "../escape.txt",
    "nested/../escape.txt",
    "nested\\..\\escape.txt",
    "nul\0byte.txt",
  ];
  for (const unsafePath of unsafePaths) {
    assert.throws(
      () => normalizeAgentMigrationWorkspaceRelativePath(
        unsafePath,
        "MIGRATION_OBJECT_STORE_UNSAFE_PATH",
      ),
      /MIGRATION_OBJECT_STORE_UNSAFE_PATH/,
      unsafePath,
    );
  }
  assert.equal(
    normalizeAgentMigrationWorkspaceRelativePath(
      "./nested\\safe//file.txt",
      "MIGRATION_OBJECT_STORE_UNSAFE_PATH",
    ),
    "nested/safe/file.txt",
  );
});
