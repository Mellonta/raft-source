import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const sites = [
  {
    label: "attachment download (including Range)",
    file: "attachments.ts",
    call: /await streamStorageResponse\(stream, res\);/g,
    expectedCount: 1,
  },
  {
    label: "attachment HTML preview two-hop transform",
    file: "attachments.ts",
    call: /await streamStorageResponseThrough\(stream, previewStream, res\);/g,
    expectedCount: 1,
  },
  {
    label: "agent API attachment download",
    file: "internalAgentApi.ts",
    call: /await streamStorageResponse\(stream, res\);/g,
    expectedCount: 1,
  },
  {
    label: "integration logo",
    file: "integrations.ts",
    call: /await streamStorageResponse\(stream, res\);/g,
    expectedCount: 1,
  },
  {
    label: "avatar",
    file: "agents.ts",
    call: /await streamStorageResponse\(stream, res\);/g,
    expectedCount: 1,
  },
  {
    label: "share artifact image",
    file: "shareArtifacts.ts",
    call: /await streamStorageResponse\(stream, res\);/g,
    expectedCount: 1,
  },
  {
    label: "external projection avatar",
    file: "externalAvatars.ts",
    call: /await streamStorageResponse\(stream, res\);/g,
    expectedCount: 1,
  },
] as const;

for (const site of sites) {
  test(`${site.label} joins the abort-safe storage response pipeline`, () => {
    const source = readFileSync(new URL(`./${site.file}`, import.meta.url), "utf8");
    assert.equal(
      [...source.matchAll(site.call)].length,
      site.expectedCount,
      `${site.file} must have exactly the expected joined pipeline call for this storage-read surface`,
    );
  });
}

// Directory-wide invariant, not a handwritten list: a NEW route file with a
// bare pipe must fail this test without anyone remembering to register it.
// externalAvatars.ts (added by #7406 while #7249 was in review) escaped the
// list-scoped predecessor of this test exactly that way — task #367.
test("no route file contains a bare pipe into an HTTP response", () => {
  const routesDir = new URL("./", import.meta.url);
  const routeFiles = readdirSync(routesDir)
    .filter((name) => name.endsWith(".ts") && !name.includes(".test."));
  assert.ok(routeFiles.length >= sites.length, "route directory enumeration must not come back empty");
  for (const file of routeFiles) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /\.pipe\(\s*(res|response|reply)\b/,
      `${file} must join the abort-safe storage response pipeline instead of a bare .pipe()`,
    );
  }
});
