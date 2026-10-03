import { join, resolve } from "node:path";

/** Keep the legacy layout unless an operator selects an external state root. */
export function raftdevStoragePaths(projectDir: string, env: NodeJS.ProcessEnv = process.env) {
  const configured = env.RAFTDEV_STATE_DIR?.trim();
  return {
    stateRoot: configured ? resolve(configured) : join(projectDir, ".slockdev"),
    seedRoot: configured ? resolve(configured) : projectDir,
  };
}
