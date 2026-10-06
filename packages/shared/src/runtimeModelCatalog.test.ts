import assert from "node:assert/strict";
import {
  RUNTIME_MODEL_CATALOG_MAX_ENTRIES,
  safeParseRuntimeModelCatalogEntries,
} from "./runtimeModelCatalog";

test("a valid report is cleaned to id/label pairs", () => {
  assert.deepEqual(
    safeParseRuntimeModelCatalogEntries([
      { id: " gpt-6-astra ", label: " GPT-6 Astra " },
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", verified: "launchable" },
    ]),
    [
      { id: "gpt-6-astra", label: "GPT-6 Astra" },
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
    ],
  );
});

test("duplicate ids keep the last reported label", () => {
  assert.deepEqual(
    safeParseRuntimeModelCatalogEntries([
      { id: "a", label: "Old" },
      { id: "a", label: "New" },
    ]),
    [{ id: "a", label: "New" }],
  );
});

test("malformed, empty and oversized reports are rejected as a whole", () => {
  assert.equal(safeParseRuntimeModelCatalogEntries(undefined), null);
  assert.equal(safeParseRuntimeModelCatalogEntries([]), null);
  assert.equal(safeParseRuntimeModelCatalogEntries("nope"), null);
  assert.equal(safeParseRuntimeModelCatalogEntries([{ id: "", label: "x" }]), null);
  assert.equal(safeParseRuntimeModelCatalogEntries([{ id: "a", label: "" }]), null);
  assert.equal(safeParseRuntimeModelCatalogEntries([{ id: "a", label: "x".repeat(500) }]), null);
  assert.equal(
    safeParseRuntimeModelCatalogEntries(
      Array.from({ length: RUNTIME_MODEL_CATALOG_MAX_ENTRIES + 1 }, (_, index) => ({ id: `m${index}`, label: `M${index}` })),
    ),
    null,
  );
});

test("control characters are stripped from labels and drop ids carrying them", () => {
  assert.deepEqual(
    safeParseRuntimeModelCatalogEntries([
      { id: "gpt-6-astra", label: "GPT-6\u0000 Astra\n" },
      { id: "gpt\u0007bad", label: "Dropped" },
    ]),
    [{ id: "gpt-6-astra", label: "GPT-6 Astra" }],
  );
});
