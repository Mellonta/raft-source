// Theme-contract regression for the channel-settings Joint sections.
//
// Both sections shipped with hardcoded brutal-only classes (`text-black`,
// `text-black/55`, `border-black/10`, `border-black/20`). On the elegant
// themes they render black-on-dark and nearly disappear (Artea flagged the
// elegant-dark screenshot on 2026-09-28). The fix follows the channel-dialog
// convention set by PR #8365: semantic tokens (`text-foreground-strong`,
// `text-foreground-muted`, `border-line-muted`) plus `theme-brutal:`
// overrides that restore the exact brutal look. These assertions pin the
// class strings on the rendered DOM so a revert cannot silently reintroduce
// black text on the dark themes.

import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, screen } from "@testing-library/react";

import { renderWithIntl } from "./helpers/intl";
import JointConversionSection from "../src/components/channel/JointConversionSection";
import JointAttachmentUploadSection from "../src/components/channel/JointAttachmentUploadSection";
import type { RecoveryView } from "../src/utils/directAttachmentUpload";

afterEach(cleanup);

const noop = () => {};

function assertHasClasses(element: Element | null, expected: string[]): void {
  assert.ok(element, `expected element for classes ${expected.join(" ")}`);
  const tokens = (element.getAttribute("class") ?? "").split(/\s+/);
  for (const cls of expected) {
    assert.ok(
      tokens.includes(cls),
      `expected "${cls}" in class="${element.getAttribute("class")}"`,
    );
  }
}

test("JointConversionSection renders theme tokens with brutal overrides", () => {
  const { container } = renderWithIntl(
    <JointConversionSection
      busy={false}
      disabled={false}
      onStart={noop}
      conversionJob={{ status: "running", phase: "prepare" }}
    />,
  );

  assertHasClasses(screen.getByTestId("channel-settings-joint-conversion-section"), [
    "border-line-muted",
    "theme-brutal:border-black/10",
  ]);
  assertHasClasses(screen.getByTestId("channel-settings-joint-conversion-title"), [
    "text-foreground-strong",
    "theme-brutal:text-black",
  ]);
  assertHasClasses(
    container.querySelector("#channel-settings-joint-conversion-description"),
    ["text-foreground-muted", "theme-brutal:text-black/55"],
  );
  // "In progress" hint on the current conversion stage (the descriptive span
  // inside the stage list that carried `text-black/55`).
  assertHasClasses(screen.getByText("In progress"), [
    "text-foreground-muted",
    "theme-brutal:text-black/55",
  ]);
});

test("JointAttachmentUploadSection renders theme tokens with brutal overrides", () => {
  const uploads: RecoveryView[] = [
    {
      uploadId: "u1",
      filename: "evidence.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      state: "pending",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
  ];
  renderWithIntl(
    <JointAttachmentUploadSection uploads={uploads} onOpenChannel={noop} onCancel={noop} />,
  );

  assertHasClasses(screen.getByTestId("channel-settings-joint-uploads-section"), [
    "border-line-muted",
    "theme-brutal:border-black/10",
  ]);
  const title = screen.getByTestId("channel-settings-joint-uploads-title");
  assertHasClasses(title, ["text-foreground-strong", "theme-brutal:text-black"]);
  assertHasClasses(title.nextElementSibling, [
    "text-foreground-muted",
    "theme-brutal:text-black/55",
  ]);
  assertHasClasses(screen.getByTestId("channel-settings-joint-upload-u1"), [
    "border-line-muted",
    "theme-brutal:border-black/20",
  ]);
});
