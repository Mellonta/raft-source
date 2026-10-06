import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// Task #424. The app-family trace keys (`app_id`, `source_id`, `item_id`,
// `app_correlation_id`) are allowed on the readable surface PER APP: each app's
// normalizer is what constrains its ids, because the type layer does not
// (`z.string().trim().min(1)` accepts any non-empty string).
//
// That ruling is only as good as the set of apps it was made against. @Leiysky
// and @Stone both asked for the same guard, and @Leiysky asked for it to live
// HERE rather than in the contract test, because the two fail differently:
//
//   the contract test  — "does every key have a destination"
//   this test          — "how wide is the value space that destination admits"
//
// So: adding a third app must trip this, and whoever adds it has to revisit the
// allowlist in trace-client `localTraceSink.ts` at the same time.

const MANIFEST = path.join(__dirname, "registry.manifest.ts");

/**
 * Read from source rather than by constructing the runtime registry: building it
 * needs a data dir, a clock and a live cleaner runtime, and this assertion is
 * about which apps are COMPOSED IN, which is a property of the file.
 */
function manifestSource(): string {
  return readFileSync(MANIFEST, "utf8");
}

test("#424 the daemon app registry is exactly system.reminder and system.cleaner", () => {
  const source = manifestSource();

  // Positive control first: if these anchors ever move, the assertions below
  // would pass vacuously by finding nothing to object to.
  assert.match(source, /inboxRegistry/, "control: the manifest must still build an inboxRegistry");
  assert.match(
    source,
    /REMINDER_AGENT_INBOX_REGISTRY/,
    "control: the reminder app must still be composed in by that name",
  );
  assert.match(
    source,
    /createSystemCleanerAppRegistry/,
    "control: the cleaner app must still be composed in by that name",
  );

  // The registry is a spread of app registries. Any additional spread into it is
  // a third app, which is exactly the event this test exists to catch.
  const block = source.slice(source.indexOf("const inboxRegistry"), source.indexOf("return {"));
  const spreads = [...block.matchAll(/\.\.\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]).sort();
  assert.deepEqual(
    spreads,
    ["REMINDER_AGENT_INBOX_REGISTRY", "createSystemCleanerAppRegistry"],
    "a third app was composed into the daemon registry. The app-family trace keys " +
      "(app_id / source_id / item_id / app_correlation_id) are allowed PER APP, and that ruling " +
      "was made against exactly these two. Before changing this list, give the new app's " +
      "normalizer an explicit constraint for its ids and revisit DIAGNOSTIC_ID_ATTRS in " +
      "packages/trace-client/src/localTraceSink.ts (task #424).",
  );
});

test("#424 the registry is composed statically — no runtime path can add an app", () => {
  const source = manifestSource();
  // If this ever gains a dynamic import or a directory scan, "the registry is
  // these two apps" stops being checkable from the source at all, and the
  // per-app ruling loses its footing.
  assert.doesNotMatch(source, /\bimport\s*\(/, "a dynamic import would let an app be added at runtime");
  assert.doesNotMatch(source, /readdir|readDirectory/, "a directory scan would do the same");
});
