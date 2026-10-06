import { flushCompileCache, getCompileCacheDir } from "node:module";

// Vitest terminates isolated forks instead of letting Node exit normally.
// Persist bytecode before that termination so the next fork can reuse it.
if (getCompileCacheDir()) {
  afterAll(() => flushCompileCache());
}
