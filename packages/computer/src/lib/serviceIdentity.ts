import { writePidfileAt } from "../internal/process-primitives";
import { servicePidPath } from "../paths";
import { writeServiceVersionEvidence } from "../runningVersionEvidence";

export interface ServiceIdentityPublishDeps {
  pid?: number;
  writePidfileAtFn?: typeof writePidfileAt;
  writeServiceVersionEvidenceFn?: typeof writeServiceVersionEvidence;
}

/** Publish service identity only after the caller owns the exclusive IPC endpoint. */
export async function publishServiceIdentityAfterIpcBind<T>(
  slockHome: string,
  bindIpc: () => Promise<T>,
  deps: ServiceIdentityPublishDeps = {},
): Promise<T> {
  const ipc = await bindIpc();
  await (deps.writePidfileAtFn ?? writePidfileAt)(
    servicePidPath(slockHome),
    deps.pid ?? process.pid,
  );
  await (deps.writeServiceVersionEvidenceFn ?? writeServiceVersionEvidence)(slockHome);
  return ipc;
}
