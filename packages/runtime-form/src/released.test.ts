import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { RELEASED_RUNTIME_FORMS, releasedRuntimeFormDefinition } from "./index";

const RELEASED_DIR = fileURLToPath(new URL("../released/", import.meta.url));

test("every released sample file is registered under its own schemaVersion with provenance", () => {
  const files = readdirSync(RELEASED_DIR).filter((name) => name.endsWith(".json")).sort();
  assert.deepEqual(files, [...RELEASED_RUNTIME_FORMS.keys()].map((version) => `${version}.json`).sort());
  for (const [version, form] of RELEASED_RUNTIME_FORMS) {
    assert.equal(form.definition.schemaVersion, version);
    assert.equal(form.provenance.schemaVersion, version);
    assert.match(form.provenance.serverCommit, /^[0-9a-f]{40}$/);
    assert.match(form.provenance.releasedIn, /^release\/v\d+\.\d+\.\d+$/);
    const onDisk = JSON.parse(readFileSync(`${RELEASED_DIR}${version}.json`, "utf8")) as { definition: unknown };
    assert.deepEqual(releasedRuntimeFormDefinition(version), onDisk.definition);
  }
});

test("a released definition is handed out as a copy", () => {
  const first = releasedRuntimeFormDefinition("builtin-pi.create.v3");
  assert.ok(first);
  first.dataSchema.properties.loadLocalPlugins = { type: "boolean", title: "mutated" };
  assert.equal(releasedRuntimeFormDefinition("builtin-pi.create.v3")?.dataSchema.properties.loadLocalPlugins?.title, "Load local Pi plugins");
});

test("an unknown schemaVersion has no released definition", () => {
  assert.equal(releasedRuntimeFormDefinition("builtin-pi.create.v999"), null);
});
