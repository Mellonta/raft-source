import { useIntl } from "react-intl";

/**
 * Frame for previewing an attacker-uploaded PDF with the browser's native viewer.
 *
 * Why this is NOT `SandboxedPreviewFrame`: Chromium refuses to instantiate its
 * PDF viewer inside ANY sandboxed browsing context — the HTML spec disables
 * plugins in sandboxed contexts and no `sandbox` token re-enables them. A
 * sandboxed PDF iframe therefore renders `chrome-error://chromewebdata/`
 * (`ERR_BLOCKED_BY_CLIENT`) in Chrome/Edge and in the Raft Desktop shell; only a
 * frame with no `sandbox` attribute renders (verified in Chrome 151 and with
 * Electron probes, task #91). Firefox's pdf.js is unaffected either way.
 *
 * So the isolation model here is CROSS-ORIGIN instead of sandbox, and what this
 * component can enforce is stated precisely:
 *  - `isPdfPreviewUrlIsolated` gates the INITIAL `src` only: absolute http(s) on
 *    an origin different from the app's. It does not see the response type, a
 *    redirect target, or any later navigation inside the frame. Same-origin,
 *    relative and other-scheme URLs are refused (download fallback), because an
 *    unsandboxed same-origin document would share cookies/storage/DOM reach.
 *  - The continuing guarantee therefore rests on the controlled attachment
 *    service: preview URLs come from the API (attachment ACL; local streaming
 *    path sets nosniff) or from storage-signed URLs that pin the response type
 *    and disposition, and the response is rendered by PDFium (`application/pdf`),
 *    which runs no page script. This function alone does NOT guarantee that the
 *    framed document can never reach app state.
 *  - Capabilities that return without `sandbox`: viewer-initiated top-level
 *    navigation and popups. The desktop shell routes off-app http(s) navigation
 *    and window.open to the system browser (it does not forbid them); the web
 *    has no shell guard. Referrer is suppressed. HTML and mermaid previews are
 *    not plugins and stay in `SandboxedPreviewFrame`.
 */
export function isPdfPreviewUrlIsolated(url: string, appOrigin: string = window.location.origin): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false; // relative or malformed → would resolve against the app origin
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  return parsed.origin !== appOrigin;
}

export default function CrossOriginPdfFrame({
  src,
  title,
  className,
}: {
  src: string;
  title: string;
  className?: string;
}) {
  const { formatMessage } = useIntl();
  if (!isPdfPreviewUrlIsolated(src)) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6 text-center text-sm text-foreground-muted theme-brutal:text-black/70" data-testid="pdf-preview-isolation-refused">
        {formatMessage({ id: "message.messageItem.pdfPreviewIsolationRefused" })}
      </div>
    );
  }
  // Intentionally no `sandbox` attribute — see the module comment. The rule below
  // is the one that introduced the sandbox; it is waived HERE ONLY because a
  // sandboxed frame cannot render a PDF at all, and the origin check above is
  // the enforced boundary instead.
  return (
    // oxlint-disable-next-line react-doctor/iframe-missing-sandbox -- Chromium's PDF viewer refuses to load in any sandboxed frame (task #91); isolation is the render-time cross-origin invariant above.
    <iframe
      title={title}
      src={src}
      referrerPolicy="no-referrer"
      className={className}
    />
  );
}
