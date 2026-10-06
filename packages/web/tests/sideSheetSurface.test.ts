/**
 * Contract test for the right-side sheet surface (task #1050).
 *
 * stdrc 2026-08-27 #proj-uiux:c50cb6c6: the chat side sheet (channel
 * settings) should read as the same surface as the sidebar. Investigation
 * showed both already share the `bg-brutal-cream` token — the perceived
 * color difference comes from two other sources:
 *
 *   1. raft-ui's Drawer renders a modal overlay (`bg-layer-backdrop`,
 *      ~60% black) over the page, dimming the sidebar while the sheet
 *      stays above it. That is intended modal drawer behavior and stays.
 *   2. The sheet carried Tailwind's `shadow-xl`, a soft blurred shadow.
 *      The design language is hard-shadow only (`--shadow-brutal*`,
 *      `--shadow-soft-popover` reserved for tiny auto-dismiss overlays),
 *      and a wide blurred band along the sheet's left edge exaggerated
 *      the boundary contrast. The full-height sheet already has a 2px
 *      black left border as its delineator, so the blur shadow is
 *      removed with no replacement.
 *
 * Surface rule after the multitheme migration (Artea directive): each side
 * sheet follows the SIDEBAR's themed background layer — a semantic
 * `bg-layer-*` token for elegant/elegant-dark, with the production cream
 * kept only inside the `theme-brutal:` variant. The channel-settings drawer
 * uses the sidebar's muted canvas layer (`bg-layer-canvas-muted
 * theme-brutal:bg-brutal-cream`); the shared OverflowSheet shell uses the
 * panel layer (`bg-layer-panel theme-brutal:bg-brutal-cream`). In brutal
 * both stay cream, visually identical to before.
 *
 * This test fails CI if a refactor:
 *   - reintroduces a Tailwind blur shadow (shadow-sm/md/lg/xl/2xl or
 *     arbitrary shadow-[...]) on any side sheet,
 *   - changes a sheet surface off its semantic `bg-layer-*` +
 *     `theme-brutal:bg-brutal-cream` pair (sidebar-layer contract),
 *   - drops the 2px left border that delineates the sheet edge.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sideSheetSurfaces = [
  {
    rel: "../src/components/ui/OverflowSheet.tsx",
    layer: "bg-layer-panel",
  },
  {
    rel: "../src/components/channel/EditChannelDialog.tsx",
    layer: "bg-layer-canvas-muted",
  },
];

const BLUR_SHADOW = /shadow-(?:sm|md|lg|xl|2xl)\b|shadow-\[/;

for (const { rel, layer } of sideSheetSurfaces) {
  test(`${rel}: side sheet keeps the sidebar layer in elegant, cream in brutal, hard-bordered, blur-shadow free`, () => {
    const source = readFileSync(resolve(import.meta.dirname, rel), "utf8");

    assert.match(
      source,
      new RegExp(`DrawerContent[\\s\\S]*?${layer}[^\\n]*theme-brutal:bg-brutal-cream`),
      `side sheet must pair the semantic sidebar layer ${layer} with theme-brutal:bg-brutal-cream`,
    );
    assert.match(
      source,
      /DrawerContent[\s\S]*?border-l-2/,
      "side sheet must keep the 2px left border delineator",
    );
    assert.doesNotMatch(
      source,
      BLUR_SHADOW,
      "side sheet must not carry a blurred shadow — hard shadows only in this design language",
    );
  });
}
