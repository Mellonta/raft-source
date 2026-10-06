import { useState } from "react";
import { useIntl } from "react-intl";
import { normalizeDisplayLocale, pickComputerReleaseNotesText } from "@botiverse/raft-shared";
import type { ComputerReleaseNotes } from "@botiverse/raft-shared";
import DialogCard from "../ui/DialogCard";
import TextLink from "../ui/TextLink";
import MarkdownContent from "../markdown/MarkdownContent";

/**
 * "What's new" link beside a Computer's "update available" hint. Opens the
 * latest Computer version's release notes (from Hands, via the machines
 * payload) in the UI language. Display only: no upgrade or other action.
 * Renders nothing when there is no text to show.
 */
export default function ComputerReleaseNotesAffordance({ notes }: { notes: ComputerReleaseNotes }) {
  const { formatMessage, locale } = useIntl();
  const [open, setOpen] = useState(false);
  const text = pickComputerReleaseNotesText(notes, normalizeDisplayLocale(locale) ?? "en");
  if (!text) return null;

  return (
    <>
      <TextLink
        variant="primary"
        className="text-xs"
        aria-haspopup="dialog"
        data-testid="computer-release-notes-open"
        onClick={() => setOpen(true)}
      >
        {formatMessage({ id: "machine.detail.releaseNotesOpen" })}
      </TextLink>
      {open && (
        <DialogCard
          title={formatMessage({ id: "machine.detail.releaseNotesTitle" }, { version: notes.version })}
          onClose={() => setOpen(false)}
          maxWidthClass="max-w-lg"
          testId="computer-release-notes-dialog"
          closeOnBackdrop
        >
          <div className="max-h-[60vh] overflow-y-auto text-sm text-foreground-strong theme-brutal:text-black">
            <MarkdownContent source={text} />
          </div>
        </DialogCard>
      )}
    </>
  );
}
