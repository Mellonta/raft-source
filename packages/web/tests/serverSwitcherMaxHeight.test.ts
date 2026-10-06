import assert from "node:assert/strict";

import { computeServerSwitcherLayout } from "../src/components/ui/serverSwitcherMenuLayout";

const GUTTER = 8;

/** After applying the computed layout, assert the menu stays inside the window and the
 *  footer is reachable (its full effective height fits between the top and bottom gutter). */
function assertInBounds(menuTop: number, menuHeight: number, viewportHeight: number) {
  const { maxHeight, shiftUp } = computeServerSwitcherLayout(menuTop, menuHeight, viewportHeight);
  const effectiveHeight = Math.min(menuHeight, maxHeight);
  const top = menuTop - shiftUp;
  const bottom = top + effectiveHeight;
  assert.ok(shiftUp >= 0, "never shifts down");
  assert.ok(top >= -0.5, `top ${top} must stay within the window (never above it)`);
  assert.ok(bottom <= viewportHeight - GUTTER + 0.5, `bottom ${bottom} must not exceed the window`);
  assert.ok(effectiveHeight <= viewportHeight - 2 * GUTTER + 0.5, "never taller than the window");
  return { maxHeight, shiftUp, top, bottom, effectiveHeight };
}

test("near-top trigger: fits below with no shift", () => {
  const r = assertInBounds(4, 1200, 900);
  assert.equal(r.shiftUp, 0);
});

test("low trigger with a long list: shifts up to the top gutter, still in-bounds (reviewer case)", () => {
  // top=800, vp=900 previously floored to 160 → bottom 960, 60px overflow. Now fits.
  const r = assertInBounds(800, 1200, 900);
  assert.equal(r.top, GUTTER);
});

test("tiny window, mid trigger: still in-bounds (reviewer case)", () => {
  // top=120, vp=200 previously floored to 160 → bottom 280, 80px overflow. Now fits.
  assertInBounds(120, 400, 200);
});

test("short list, low trigger: shifts up only as much as needed", () => {
  const r = assertInBounds(800, 300, 900);
  assert.equal(r.effectiveHeight, 300);
  assert.equal(r.bottom, 900 - GUTTER);
});

test("never taller than the window even when content is huge", () => {
  const { maxHeight } = computeServerSwitcherLayout(4, 100000, 900);
  assert.equal(maxHeight, 900 - 2 * GUTTER);
});
