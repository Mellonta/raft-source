import { Button, Popover, PopoverTrigger, PopoverContent } from "raft-ui";
import Tooltip from "../ui/Tooltip";
import { useOptionalAppTheme } from "../../hooks/useAppTheme";
import { useEffect, useState } from "react";
import type { ComponentType } from "react";
import type { PickerProps } from "emoji-picker-react";
import { SmilePlus, X } from "lucide-react";
import { useIntl } from "react-intl";

export default function SidebarSectionEmojiPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (emoji: string) => void;
}) {
  const { formatMessage } = useIntl();
  const [open, setOpen] = useState(false);
  const [EmojiPicker, setEmojiPicker] = useState<ComponentType<PickerProps> | null>(null);
  const appTheme = useOptionalAppTheme();

  useEffect(() => {
    if (!open || EmojiPicker) return;
    let cancelled = false;

    void import("emoji-picker-react").then((module) => {
      // Vite unwraps the package's CommonJS compatibility wrapper, while the
      // repository's direct Node DOM runner exposes another `.default` layer.
      const candidate = module.default as unknown;
      const component = (
        (candidate as { default?: ComponentType<PickerProps> }).default
        ?? candidate
      ) as ComponentType<PickerProps>;
      if (!cancelled) setEmojiPicker(() => component);
    });

    return () => {
      cancelled = true;
    };
  }, [EmojiPicker, open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content={formatMessage({ id: value ? "layout.sidebar.changeEmoji" : "layout.sidebar.chooseEmoji" })}>
        <PopoverTrigger
          render={(
            <Button type="button" variant="ghost" size="icon-md"
              aria-label={value
                ? formatMessage({ id: "layout.sidebar.changeSectionEmojiAria" }, { emoji: value })
                : formatMessage({ id: "layout.sidebar.chooseSectionEmoji" })}
              className="text-xl"
            >
              {value || <SmilePlus size={18} aria-hidden />}
            </Button>
          )}
        />
      </Tooltip>
      {open && (
        <PopoverContent
          align="start"
          role="dialog"
          aria-label={formatMessage({ id: "layout.sidebar.chooseSectionEmoji" })}
          className="z-[70] p-0"
        >
          {value && (
            <button
              type="button"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              className="flex h-9 w-full items-center justify-center gap-2 border-b border-line-muted bg-layer-panel px-3 text-xs font-bold hover:bg-fill-muted"
            >
              <X size={14} aria-hidden />
              {formatMessage({ id: "layout.sidebar.noEmoji" })}
            </button>
          )}
          {EmojiPicker ? (
            <EmojiPicker
              width="min(340px, calc(100vw - 48px))"
              height={360}
              theme={(appTheme?.resolvedMode === "dark" ? "dark" : "light") as PickerProps["theme"]}
              lazyLoadEmojis
              previewConfig={{ showPreview: false }}
              onEmojiClick={(emojiData) => {
                onChange(emojiData.emoji);
                setOpen(false);
              }}
            />
          ) : (
            <div role="status" className="flex h-24 w-[min(340px,calc(100vw-48px))] items-center justify-center text-sm text-foreground-muted">
              {formatMessage({ id: "layout.sidebar.loadingEmoji" })}
            </div>
          )}
        </PopoverContent>
      )}
    </Popover>
  );
}
