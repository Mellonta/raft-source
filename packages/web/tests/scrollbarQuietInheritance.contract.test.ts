/**
 * Contract: hovering a `.scrollbar-quiet` scroller must not restyle its whole
 * subtree (task #137).
 *
 * `scrollbar-color` is an INHERITED property. `.scrollbar-quiet:hover` darkens
 * the thumb by changing it on the scroller, so without a stop every descendant
 * inherits the new value and recomputes its style: entering/leaving the message
 * list or sidebar restyled ~10k elements (up to 15k; 66 of 528 pointer moves
 * across the window on a real busy channel → 0 with the stop). The stop gives
 * the scroller's direct children a constant value, declared BEFORE the
 * `.scrollbar-quiet` rule so a nested `.scrollbar-quiet` scroller keeps its own.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "vitest";

const css = readFileSync(resolve(import.meta.dirname, "../src/index.css"), "utf8");

test("the hover rule changes scrollbar-color only behind an inheritance stop", () => {
  const stop = css.search(/\.scrollbar-quiet\s*>\s*\*\s*\{\s*scrollbar-color:\s*rgba\([^)]*\)\s+transparent;\s*\}/);
  const base = css.search(/\n\s*\.scrollbar-quiet\s*\{/);
  const hover = css.search(/\.scrollbar-quiet:hover\s*\{\s*scrollbar-color:/);
  assert.ok(hover >= 0, "the hover darkening still exists (design intent)");
  assert.ok(stop >= 0, "children must get a constant scrollbar-color instead of inheriting the hover value");
  assert.ok(stop < base, "the stop must precede .scrollbar-quiet so a nested scroller's own rule wins");
});

test("the stop uses the same resting color as the scroller (no visual change at rest)", () => {
  const color = (re: RegExp) => (css.match(re) ?? [])[1];
  assert.equal(
    color(/\.scrollbar-quiet\s*>\s*\*\s*\{\s*scrollbar-color:\s*(rgba\([^)]*\))/),
    color(/\n\s*\.scrollbar-quiet\s*\{\s*scrollbar-color:\s*(rgba\([^)]*\))/),
  );
});
