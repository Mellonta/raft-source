import { test as base } from "vitest";
import { setTimeout, clearTimeout } from "node:timers";
import type { Database } from "../../db/index";
import { openTestDatabase } from "./database";
import { enterIntegrationCase, IntegrationLifecycle, poisonIntegrationEnvironment } from "./lifecycle";

import type { createSeed } from "./seed";

interface DatabaseFixtures {
  lifecycle: IntegrationLifecycle;
  db: Database;
  seed: ReturnType<typeof createSeed>;
}

export const dbTest = base.extend<DatabaseFixtures>({
  lifecycle: [async ({ task }, use) => {
    const started = performance.now();
    const lifecycle = new IntegrationLifecycle();
    const leave = enterIntegrationCase(lifecycle);
    // context.skip() inside a case skips fixture teardown. Fail normally instead;
    // declare conditional cases with test.skipIf() before acquiring resources.
    // (Vitest types `skip` as read-only; the override is deliberate and restored below.)
    const mutableContext = task.context as { skip: typeof task.context.skip };
    const skip = mutableContext.skip;
    mutableContext.skip = (() => { throw new Error("Use test.skipIf before acquiring integration fixtures; context.skip() skips fixture teardown"); }) as typeof task.context.skip;
    // Vitest's onFinished hook also runs if another afterEach/fixture throws.
    task.context.onTestFinished(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          lifecycle.measure("cleanup", () => lifecycle.close()),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Integration cleanup did not finish within 30 seconds")), 30_000);
          }),
        ]);
      } catch (error) {
        poisonIntegrationEnvironment(error instanceof Error ? error : new Error(String(error)));
        throw error;
      } finally {
        clearTimeout(timer);
        leave();
        mutableContext.skip = skip;
        // Vitest retains task.context after a case; release closed WASM/HTTP
        // fixtures instead of keeping every database alive until the file ends.
        for (const key of ["db", "app", "seed", "http", "lifecycle"]) {
          Reflect.deleteProperty(task.context, key);
        }
        if (process.env.RAFT_TEST_PROFILE === "1" || task.result?.state === "fail") {
          console.log(JSON.stringify({ integrationTest: task.name, durationMs: performance.now() - started, phasesMs: lifecycle.timings, memoryBytes: process.memoryUsage() }));
        }
      }
    });
    await use(lifecycle);
  }, { auto: true }],
  seed: async ({ db }, use) => {
    const { createSeed } = await import("./seed");
    await use(createSeed(db));
  },
  db: async ({ lifecycle }, use) => {
    void lifecycle;
    const db = await openTestDatabase();
    await use(db);
  },
});
