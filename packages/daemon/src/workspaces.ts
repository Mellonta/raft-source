import { access, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { RUNTIME_OUTCOME_OUTBOX_DIR_NAME } from "./runtimeOutcomeOutbox";
import path from "node:path";
import type { WorkspaceDirectoryInfo } from "@botiverse/raft-shared";
import { logger } from "./logger";

export interface AgentWorkspaceSeedFile {
  relativePath: string;
  content: string;
}

export async function initializeAgentWorkspace(
  workspacePath: string,
  initialMemoryMd: string,
  seedFiles: AgentWorkspaceSeedFile[],
  envVars?: Record<string, string> | null,
): Promise<void> {
  await mkdir(workspacePath, { recursive: true });
  const memoryMdPath = path.join(workspacePath, "MEMORY.md");
  try {
    await access(memoryMdPath);
  } catch {
    await writeFile(memoryMdPath, initialMemoryMd);
  }

  await mkdir(path.join(workspacePath, "notes"), { recursive: true });
  for (const { relativePath, content } of seedFiles) {
    const fullPath = path.join(workspacePath, relativePath);
    try {
      await access(fullPath);
    } catch {
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content);
    }
  }
}

// Containment, not a blocklist. The previous guard rejected "/", "\\" and ".." -- every
// traversal string and nothing else -- so it let through "." and "", which path.join
// collapses to `dataDir` itself. A request naming one workspace then deleted the root
// holding every agent workspace on the machine, and reported ordinary success.
//
// A blocklist can only reject the inputs its author anticipated. Resolving the path and
// asserting it is strictly below `dataDir` rejects the whole class instead, including
// the members nobody has thought of yet.
export function resolveWorkspaceDirectoryPath(dataDir: string, directoryName: string): string | null {
  const root = path.resolve(dataDir);
  const target = path.resolve(root, directoryName);
  // Exactly one level below the root. `dirname === root` rejects the root itself
  // ("." and ""), anything above it ("..", "../x"), and any nested path
  // ("nested/agent-1") in a single comparison -- workspace names are agent ids and
  // are always a single segment.
  if (path.dirname(target) !== root) {
    return null;
  }
  return target;
}

interface WorkspaceDirectorySummary {
  totalSizeBytes: number;
  fileCount: number;
  latestMtime: Date;
}

function emptyWorkspaceDirectorySummary(latestMtime = new Date(0)): WorkspaceDirectorySummary {
  return {
    totalSizeBytes: 0,
    fileCount: 0,
    latestMtime,
  };
}

function mergeWorkspaceDirectorySummaries(
  base: WorkspaceDirectorySummary,
  next: WorkspaceDirectorySummary,
): WorkspaceDirectorySummary {
  return {
    totalSizeBytes: base.totalSizeBytes + next.totalSizeBytes,
    fileCount: base.fileCount + next.fileCount,
    latestMtime: next.latestMtime > base.latestMtime ? next.latestMtime : base.latestMtime,
  };
}

async function summarizeWorkspaceEntry(entryPath: string, entry: { isDirectory(): boolean; isFile(): boolean }): Promise<WorkspaceDirectorySummary> {
  try {
    const info = await stat(entryPath);
    if (entry.isDirectory()) {
      return summarizeWorkspaceDirectory(entryPath);
    }

    if (entry.isFile()) {
      return {
        totalSizeBytes: info.size,
        fileCount: 1,
        latestMtime: info.mtime,
      };
    }

    return emptyWorkspaceDirectorySummary(info.mtime);
  } catch {
    return emptyWorkspaceDirectorySummary();
  }
}

async function summarizeWorkspaceDirectory(dirPath: string): Promise<WorkspaceDirectorySummary> {
  let summary = emptyWorkspaceDirectorySummary();
  try {
    const rootInfo = await stat(dirPath);
    summary = emptyWorkspaceDirectorySummary(rootInfo.mtime);
  } catch {
    return summary;
  }

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return summary;
  }

  const childSummaries = await Promise.all(
    entries.map((entry) => summarizeWorkspaceEntry(path.join(dirPath, entry.name), entry)),
  );

  for (const childSummary of childSummaries) {
    summary = mergeWorkspaceDirectorySummaries(summary, childSummary);
  }

  return summary;
}

export async function scanWorkspaceDirectories(dataDir: string): Promise<WorkspaceDirectoryInfo[]> {
  let entries;
  try {
    entries = await readdir(dataDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results = await Promise.all(
    entries.map(async (entry) => {
      // RFC 071: the runtime-outcome outbox lives beside the workspaces; it is not one.
      if (!entry.isDirectory() || entry.name === RUNTIME_OUTCOME_OUTBOX_DIR_NAME) {
        return null;
      }

      const dirPath = path.join(dataDir, entry.name);
      try {
        const summary = await summarizeWorkspaceDirectory(dirPath);
        return {
          directoryName: entry.name,
          totalSizeBytes: summary.totalSizeBytes,
          lastModified: summary.latestMtime.toISOString(),
          fileCount: summary.fileCount,
        } satisfies WorkspaceDirectoryInfo;
      } catch {
        return null;
      }
    }),
  );

  return results.filter((entry): entry is WorkspaceDirectoryInfo => entry !== null);
}

export async function deleteWorkspaceDirectory(dataDir: string, directoryName: string): Promise<boolean> {
  const targetDir = resolveWorkspaceDirectoryPath(dataDir, directoryName);
  if (!targetDir) {
    return false;
  }
  try {
    await rm(targetDir, { recursive: true, force: true });
    logger.info(`[Workspace] Deleted directory: ${targetDir}`);
    return true;
  } catch (err) {
    logger.error(`[Workspace] Failed to delete directory ${targetDir}`, err);
    return false;
  }
}
