import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = readFileSync(resolve(root, "src/components/message/MessageInput.tsx"), "utf8");

// The composer attachment preview (SortableAttachment + its render site) is a
// pure display layer over RUI composer-attachment parts: the recipe owns all
// brutal / elegant-light / elegant-dark chrome, so this region must not carry
// any raw brutal hardcodes (border-black, bg-white, bg-brutal-*, text-black) —
// not even behind `theme-brutal:`, because the RUI brutal recipe already
// reproduces the production brutal look.
const sortableAttachmentRegion = source.slice(
  source.indexOf("function SortableAttachment"),
  source.indexOf("function MentionCandidateBody"),
);

test("composer attachment preview renders through RUI composer-attachment parts", () => {
  assert.match(sortableAttachmentRegion, /<ComposerAttachment ref=\{setNodeRef\}/);
  assert.match(sortableAttachmentRegion, /<ComposerAttachmentImage>/);
  assert.match(sortableAttachmentRegion, /<ComposerAttachmentFile>/);
  assert.match(sortableAttachmentRegion, /<ComposerAttachmentBody>/);
  assert.match(sortableAttachmentRegion, /<ComposerAttachmentTitle>/);
  assert.match(sortableAttachmentRegion, /<ComposerAttachmentMeta>/);
  assert.match(sortableAttachmentRegion, /<ComposerAttachmentUploadingOverlay>/);
  assert.match(sortableAttachmentRegion, /<ComposerAttachmentFailedOverlay>/);
  assert.match(sortableAttachmentRegion, /<ComposerAttachmentUploadProgressBar value=\{uploadProgress\} \/>/);
  assert.match(sortableAttachmentRegion, /<ComposerAttachmentRemove/);
  assert.match(source, /<ComposerAttachments>/);
});

test("composer attachment preview carries no raw brutal hardcodes", () => {
  assert.doesNotMatch(
    sortableAttachmentRegion,
    /\b(?:border-black|bg-white|bg-brutal-[a-z]+|text-black)\b/,
    "theme chrome belongs to the RUI recipe, not to local hardcodes",
  );
});

test("drag-sort wiring keeps the remove button outside the drag handle", () => {
  // dnd-kit listeners must stay on the chip body only — spreading them on the
  // outer sortable node would let PointerSensor's native pointerdown swallow
  // ✕ taps on touch devices (tygg #proj-mobile task #8).
  assert.match(sortableAttachmentRegion, /<ComposerAttachment ref=\{setNodeRef\} style=\{style\} \{\.\.\.attributes\}>/);
  assert.match(sortableAttachmentRegion, /<div\s+\{\.\.\.listeners\}/, "listeners stay on the inner chip body");
  assert.match(sortableAttachmentRegion, /\{\.\.\.listeners\}[\s\S]*<ComposerAttachmentRemove/);
});
