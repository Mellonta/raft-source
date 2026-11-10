import assert from "node:assert/strict";
import { vi } from "vitest";
import { createApiTest } from "../test/integration/apiTest";

const test = createApiTest();

test("portal can read the effective policy without an account, with no cached or private configuration", async ({ app }) => {
  try {
    for (const [setting, enabled] of [["0", false], ["1", true]] as const) {
      vi.stubEnv("RAFT_PRIVACY_MODE", setting);
      const response = await fetch(`${app.baseUrl}/api/privacy-mode`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("cache-control") ?? "", /no-store/);
      assert.deepEqual(await response.json(), { enabled });
    }
  } finally { vi.unstubAllEnvs(); }
});
