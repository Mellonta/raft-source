import { enforceSupportedNodeRuntime } from "./runtimePreflight";

enforceSupportedNodeRuntime();

void import("./main").catch((err: unknown) => {
  process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
