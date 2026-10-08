import type { IntlShape } from "react-intl";

type FormatMessage = IntlShape["formatMessage"];

export async function copyTextToClipboard(
  text: string,
  formatMessage?: FormatMessage,
): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Plain HTTP has no Clipboard API. Copy during the click's user activation,
  // keeping the textarea inside any dialog that currently owns focus.
  const focused = document.activeElement;
  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
    : [];
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.readOnly = true;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  (focused?.closest('dialog, [role="dialog"]') ?? document.body).appendChild(ta);
  ta.focus({ preventScroll: true });
  ta.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error(
        formatMessage
          ? formatMessage({ id: "message.share.clipboardRejected" })
          : "The browser rejected the clipboard copy command",
      );
    }
  } finally {
    ta.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
}
