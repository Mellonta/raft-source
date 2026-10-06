import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(resolve(repoRoot, p), "utf8");

const shell = read("src/components/ui/PreviewShell.tsx");
const quoted = read("src/components/ui/cards/QuotedMessageCard.tsx");
const attachment = read("src/components/message/AttachmentChip.tsx");

test("PreviewShell exports the canonical preview skin recipe (single source)", () => {
  assert.match(shell, /export const PREVIEW_SHELL_BORDER = "border border-line-muted hover:border-line-strong theme-brutal:border-black\/15 theme-brutal:hover:border-black\/30";/);
  // Skin is hover-only: press inherits hover styling (`:hover` keeps matching
  // while `:active` is true). Pre-refactor QuotedMessageCard never had an
  // active token, and a `color-mix(in oklab, …, transparent)` × element
  // `opacity` combo paints cyan on Chromium — both reasons to keep the shell
  // press-token-free. stdrc 2026-05-23 #proj-theme:441c8b2b cfd10230.
  assert.match(shell, /export const PREVIEW_SHELL_SKIN = `\$\{PREVIEW_SHELL_BORDER\} bg-layer-panel hover:bg-fill-muted theme-brutal:bg-white theme-brutal:hover:bg-black\/5 shadow-none`;/);
  assert.doesNotMatch(shell, /active:bg-soft-signal/);
  assert.doesNotMatch(shell, /active:opacity-90/);
  assert.match(shell, /export const PREVIEW_SHELL_SKIN_MUTED =\s*"border border-line-muted bg-fill-muted italic text-foreground-placeholder hover:shadow-raft-sm theme-brutal:border-2 theme-brutal:border-black\/30 theme-brutal:bg-black\/5 theme-brutal:text-black\/40 theme-brutal:hover:shadow-brutal-sm";/);
  // Polymorphic root (button when clickable, else div).
  assert.match(shell, /const Root = onClick \? "button" : "div";/);
  assert.match(shell, /type: "button" as const/);
  // Layout is caller-supplied via className — no hardcoded `w-full text-left
  // group` in the shell. (Drives stdrc 2026-05-22 7d19c377 / 4365db5a:
  // AttachmentChip can now wrap PreviewShell with its fixed-size layout.)
  assert.doesNotMatch(shell, /group w-full text-left/);
});

test("QuotedMessageCard consumes PreviewShell with its own layout className", () => {
  assert.match(quoted, /import PreviewShell from "\.\.\/PreviewShell";/);
  // Layout class moved from PreviewShell defaults to caller.
  assert.match(quoted, /<PreviewShell variant="muted" onClick=\{onClick\} data-testid="quoted-message-card" className="group block w-full text-left">/);
  assert.match(quoted, /<PreviewShell onClick=\{onClick\} data-testid="quoted-message-card" className="group block w-full text-left">/);
  assert.doesNotMatch(quoted, /const Root = onClick \? "button" : "div";/);
  assert.doesNotMatch(quoted, /border border-black\/15 bg-white text-left/);
  assert.doesNotMatch(quoted, /<Root\b/);
});

test("AttachmentChip builds on RUI MessageAttachmentCard (task #640 follow-up)", () => {
  // 2026-09-23 (Artea): the chip shell migrated from PreviewShell to RUI's
  // MessageAttachment recipe family — the RUI brutal card has no hard shadow
  // (`border-black/15 bg-white hover:border-black/30 hover:bg-ink-2`).
  // QuotedMessageCard keeps PreviewShell; only the chip moved.
  assert.match(attachment, /from "raft-ui"/);
  assert.match(attachment, /MessageAttachmentCard/);
  assert.match(attachment, /<MessageAttachmentCard\b/);
  assert.match(attachment, /<MessageAttachmentTitle\b/);
  assert.match(attachment, /<MessageAttachmentMeta\b/);
  assert.match(attachment, /<MessageAttachmentMetaEnd\b/);
  assert.match(attachment, /<MessageAttachmentAction\b/);
  assert.doesNotMatch(attachment, /import PreviewShell/);
  assert.doesNotMatch(attachment, /<PreviewShell\b/);
  // Layout-only constant — no border / bg / hover tokens (those live on the
  // RUI card recipe). Width-contract guards (w-44 / min-w-44 / max-w-44 /
  // shrink-0 / overflow-hidden) are positively pinned here so breaking the
  // callsite layout literal turns this red.
  const layout = attachment.match(/const COMPACT_CHIP_LAYOUT = "([^"]+)";/);
  assert.ok(layout, "COMPACT_CHIP_LAYOUT must remain a static literal (width contract)");
  assert.match(layout![1], /(^| )w-44( |$)/);
  assert.match(layout![1], /(^| )min-w-44( |$)/);
  assert.match(layout![1], /(^| )max-w-44( |$)/);
  assert.match(layout![1], /(^| )shrink-0( |$)/);
  assert.match(layout![1], /(^| )overflow-hidden( |$)/);
  assert.doesNotMatch(layout![1], /border-black\/15/);
  assert.doesNotMatch(layout![1], /hover:border-black\/30/);
  assert.doesNotMatch(layout![1], /\bbg-white\b/);
  assert.doesNotMatch(layout![1], /hover:bg-black\/5/);
  assert.doesNotMatch(layout![1], /active:bg-soft-signal/);
  // The layout literal is passed to the RUI card, keeping the width contract
  // on the rendered root.
  assert.match(attachment, /className=\{`\$\{COMPACT_CHIP_LAYOUT\}/);
  // Old route-A border style must stay gone.
  assert.doesNotMatch(attachment, /border-2 border-black\b(?!\/)/);
});
