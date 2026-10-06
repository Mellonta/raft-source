import { Card, InputGroup, InputGroupAddon, InputGroupInput, Button } from "raft-ui";
import CloseButton from "../ui/CloseButton";
import { useState } from "react";
import { X } from "lucide-react";
import { useIntl } from "react-intl";
import Modal from "../Modal";
import SidebarSectionEmojiPicker from "./SidebarSectionEmojiPicker";

export default function SidebarSectionDialog({
  title,
  initialName = "",
  initialEmoji = "",
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  initialName?: string;
  initialEmoji?: string;
  submitLabel: string;
  onSubmit: (value: { name: string; emoji: string | null }) => void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const [name, setName] = useState(initialName);
  const [emoji, setEmoji] = useState(initialEmoji);
  const trimmedName = name.trim();

  return (
    <Modal onClose={onClose} closeOnBackdrop>
      <Card className="w-full max-w-sm p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-base font-bold uppercase">{title}</h2>
          <CloseButton type="button" onClick={onClose} className="" aria-label={formatMessage({ id: "common.close" })}>
            <X size={18} />
          </CloseButton>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!trimmedName) return;
            onSubmit({ name: trimmedName, emoji: emoji.trim() || null });
          }}
          className="space-y-4"
        >
          <div>
            <div className="mb-1 text-xs font-bold uppercase">
              {formatMessage({ id: "layout.sidebar.sectionName" })}
            </div>
            <InputGroup>
              <InputGroupAddon className="p-0">
              <SidebarSectionEmojiPicker value={emoji} onChange={setEmoji} />
              </InputGroupAddon>
              <InputGroupInput
                autoFocus
                aria-label={formatMessage({ id: "layout.sidebar.sectionName" })}
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="min-w-0 flex-1 normal-case"
                placeholder={formatMessage({ id: "layout.sidebar.sectionNamePlaceholder" })}
              />
            </InputGroup>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" type="button" onClick={onClose} className="px-3 py-2 text-sm">
              {formatMessage({ id: "layout.sidebar.cancelSection" })}
            </Button>
            <Button size="sm" variant="accent" type="submit" disabled={!trimmedName} className="px-3 py-2 text-sm disabled:opacity-50">
              {submitLabel}
            </Button>
          </div>
        </form>
      </Card>
    </Modal>
  );
}
