import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
import CrossOriginPdfFrame, { isPdfPreviewUrlIsolated } from "../src/components/ui/CrossOriginPdfFrame";

// Task #91: the PDF frame has no sandbox (Chromium cannot run its PDF viewer in
// one), so the origin boundary is the security boundary and must be ENFORCED.
afterEach(() => cleanup());

test("isPdfPreviewUrlIsolated: only absolute http(s) URLs on a different origin qualify", () => {
  const app = "https://app.raft.build";
  assert.equal(isPdfPreviewUrlIsolated("https://api.raft.build/attachments/x/inline", app), true);
  assert.equal(isPdfPreviewUrlIsolated("https://abc.r2.cloudflarestorage.com/bucket/x.pdf?X-Amz-Signature=1", app), true);
  assert.equal(isPdfPreviewUrlIsolated("https://app.raft.build/attachments/x.pdf", app), false, "same origin → refused");
  assert.equal(isPdfPreviewUrlIsolated("/attachments/x.pdf", app), false, "relative → would resolve to the app origin");
  assert.equal(isPdfPreviewUrlIsolated("javascript:alert(1)", app), false);
  assert.equal(isPdfPreviewUrlIsolated("blob:https://app.raft.build/uuid", app), false);
  assert.equal(isPdfPreviewUrlIsolated("", app), false);
  // Desktop shell: app origin is app://raft; API/storage https origins are isolated from it.
  assert.equal(isPdfPreviewUrlIsolated("https://api.raft.build/attachments/x/inline", "app://raft"), true);
  assert.equal(isPdfPreviewUrlIsolated("app://raft/attachments/x.pdf", "app://raft"), false);
});

test("renders an unsandboxed frame for a cross-origin URL", () => {
  render(<TestIntlProvider locale="en"><CrossOriginPdfFrame title="PDF preview: a.pdf" src="https://example.invalid/a.pdf" /></TestIntlProvider>);
  const frame = document.querySelector("iframe");
  assert.ok(frame);
  assert.equal(frame.getAttribute("src"), "https://example.invalid/a.pdf");
  assert.equal(frame.hasAttribute("sandbox"), false);
  assert.equal(frame.getAttribute("referrerpolicy"), "no-referrer");
});

test("refuses to render a same-origin URL and shows the download hint instead", () => {
  const sameOrigin = `${window.location.origin}/attachments/a.pdf`;
  render(<TestIntlProvider locale="en"><CrossOriginPdfFrame title="PDF preview: a.pdf" src={sameOrigin} /></TestIntlProvider>);
  assert.equal(document.querySelector("iframe"), null);
  assert.ok(screen.getByTestId("pdf-preview-isolation-refused"));
});
