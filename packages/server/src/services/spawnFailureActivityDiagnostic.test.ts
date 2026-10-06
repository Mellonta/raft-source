import assert from "node:assert/strict";
import { normalizeSpawnFailureActivityDiagnostic } from "./spawnFailureActivityDiagnostic";

describe("normalizeSpawnFailureActivityDiagnostic (task #1123)", () => {
  test("accepts every closed-enum reason and keeps model only for model_not_found", () => {
    assert.deepEqual(normalizeSpawnFailureActivityDiagnostic({ reason: "model_not_found", model: "claude-opus-5" }), { reason: "model_not_found", model: "claude-opus-5" });
    assert.deepEqual(normalizeSpawnFailureActivityDiagnostic({ reason: "runtime_not_found", model: "ignored" }), { reason: "runtime_not_found" });
    assert.deepEqual(normalizeSpawnFailureActivityDiagnostic({ reason: "runtime_spawn_failed" }), { reason: "runtime_spawn_failed" });
  });
  test("rejects unknown reasons, non-objects, and unbounded or non-string models", () => {
    for (const bad of [null, undefined, "model_not_found", 42, [], {}, { reason: "disk_full" }, { reason: "model_not_found", model: 7 }, { reason: "model_not_found", model: "" }, { reason: "model_not_found", model: "x".repeat(129) }]) {
      assert.equal(normalizeSpawnFailureActivityDiagnostic(bad as never), null, JSON.stringify(bad));
    }
  });
});
