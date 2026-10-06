import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const fixtureData = JSON.parse(
  readFileSync(new URL("../../visual-testing/shared/fixtureData.json", import.meta.url), "utf8"),
) as { registerForm?: { name?: unknown } };

test("register fixture keeps the exact cross-platform name field", () => {
  assert.equal(fixtureData.registerForm?.name, "Product UX Designer");
});
