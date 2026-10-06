import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const webRoot = resolve(import.meta.dirname, "..");
const css = readFileSync(resolve(webRoot, "src/index.css"), "utf8");

// The two profile-split dividers used to be a hardcoded `2px solid #000`,
// which leaked Brutal's border into Elegant (WAWQAQ report, task #668).
// They must follow the theme: Elegant gets the standard hairline
// (`--line-muted`, the same token as every other panel divider), Brutal keeps
// its 2px black edge scoped behind [data-theme="brutal"].
const COLLAPSE_CHANNEL =
  '.thread-layout-container:has(> .thread-profile-side-column[data-collapse-channel="true"]) > .thread-side-column';
const COLLAPSE_THREAD =
  '.thread-layout-container:has(> .thread-profile-side-column[data-collapse-thread="true"]) > .thread-profile-side-column > [data-testid="profile-panel"]';

const COLLAPSE_CHANNEL_PROFILE =
  '.thread-layout-container:has(> .thread-profile-side-column[data-collapse-channel="true"]) > .thread-profile-side-column > [data-testid="profile-panel"]';

function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `missing rule: ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

test("profile split dividers are theme-aware, not a hardcoded black border", () => {
  // Every profile split draws its divider on the profile pane (task #683): the
  // pane on the right owns the seam, including Thread | Profile.
  for (const selector of [COLLAPSE_THREAD, COLLAPSE_CHANNEL_PROFILE]) {
    const rule = ruleBody(selector);
    assert.match(rule, /border-left:\s*1px solid var\(--line-muted\)/, selector);
    assert.doesNotMatch(rule, /#000/, selector);
    // Brutal keeps its black edge, but only inside the brutal theme scope.
    assert.match(ruleBody(`[data-theme="brutal"] ${selector}`), /border-left:\s*2px solid #000/, selector);
  }
  // The folded-channel thread no longer draws a right edge next to the profile.
  assert.doesNotMatch(ruleBody(COLLAPSE_CHANNEL), /border-right/);

  // No unscoped hardcoded black border may come back anywhere in index.css:
  // every `2px solid #000` must sit in a rule whose selector is brutal-scoped.
  const blackBorders = [...css.matchAll(/2px solid #000/g)];
  assert.ok(blackBorders.length > 0, "the brutal edges themselves must still be present");
  for (const match of blackBorders) {
    const ruleStart = css.lastIndexOf("}", match.index) + 1;
    const selector = css.slice(ruleStart, css.indexOf("{", ruleStart)).trim();
    assert.match(selector, /^\[data-theme="brutal"\] /, `unscoped black border in: ${selector}`);
  }
});

// Chat | Profile with no thread in the row (task #683). The divider used to be
// drawn only by the profile's resize handle, which sits over the chat column,
// so the composer bar (stacked above it) hid the line along its height.
const PLAIN_SPLIT =
  '.thread-layout-container:has(> .thread-profile-side-column[data-collapse-channel="false"][data-collapse-thread="false"]) > .thread-profile-side-column > [data-testid="profile-panel"]';

test("the plain chat | profile split draws its one divider on the profile pane", () => {
  const plain = ruleBody(PLAIN_SPLIT);
  assert.match(plain, /border-left:\s*1px solid var\(--line-muted\)/);
  const brutal = ruleBody(`[data-theme="brutal"] ${PLAIN_SPLIT}`);
  assert.match(brutal, /border-left:\s*2px solid #000/);
});

test("a profile beside a conversation never squeezes it below a readable width", () => {
  // Same 320px floor the Channel | Thread split already keeps.
  for (const selector of [PLAIN_SPLIT, COLLAPSE_THREAD, COLLAPSE_CHANNEL_PROFILE]) {
    assert.match(ruleBody(selector), /max-width:\s*calc\(100% - 320px\)/, selector);
  }
});

test("below the split threshold the conversation folds away instead of shrinking", () => {
  const anchor = css.indexOf(".thread-layout-container:has(> .thread-profile-side-column) > .thread-main-column,");
  const start = css.lastIndexOf("@container thread-layout (max-width: 679.98px)", anchor);
  assert.ok(anchor >= 0 && start >= 0, "missing the narrow-row collapse block");
  const block = css.slice(start, css.indexOf("\n  }\n}", start));
  assert.match(block, /> \.thread-main-column,\s*\n\s*\.thread-layout-container:has\(> \.thread-profile-side-column\) > \.thread-side-column \{\s*display: none;/);
  // The profile then sits against the sidebar, which already draws that edge.
  assert.match(block, /\[data-testid="profile-panel"\] \{[^}]*border-left: 0;/);
});

test("profile resize handles are transparent; the pane box owns the divider", () => {
  const source = readFileSync(resolve(webRoot, "src/components/profile/ProfilePanel.tsx"), "utf8");
  const handle = source.match(/const RESIZE_HANDLE_CLASS_NAME = "([^"]+)"/);
  assert.ok(handle, "missing RESIZE_HANDLE_CLASS_NAME");
  assert.doesNotMatch(handle[1], /\bborder/);
  assert.doesNotMatch(source, /cursor-col-resize[^"]*border-l/);
  assert.equal((source.match(/className=\{RESIZE_HANDLE_CLASS_NAME\}/g) ?? []).length, 5);
});

test("a thread that is first in the row draws no left edge next to the sidebar", () => {
  const THREAD_ROOT = '.thread-side-column > [data-slot="thread-panel-root"]';
  // Folded channel (Thread | Profile).
  assert.match(
    ruleBody(`${COLLAPSE_CHANNEL} > [data-slot="thread-panel-root"]`),
    /border-left-width:\s*0/,
  );
  // Thread-only modes: narrow row, and portrait below xl.
  for (const at of ["@container thread-layout (max-width: 679.98px)", "@media (orientation: portrait) and (max-width: 1279.98px)"]) {
    const start = css.indexOf(`${at} {\n  ${THREAD_ROOT}`);
    assert.ok(start >= 0, `missing thread-first rule under ${at}`);
    assert.match(css.slice(start, css.indexOf("}", start)), /border-left-width:\s*0/);
  }
});
