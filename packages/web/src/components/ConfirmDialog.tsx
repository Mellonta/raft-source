import { useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import type { Locale } from "../i18n/locale";
import { mergedMessages } from "../i18n/messages";
import type { MessageId } from "../i18n/messages";
import Banner from "./ui/Banner";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner,
  Button,
} from "raft-ui";
import type { ButtonProps } from "raft-ui";

interface ConfirmDialogProps {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  loadingLabel?: string;
  confirmIcon?: ReactNode;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
  confirmDisabled?: boolean;
  /** Semantic button variant for the confirm action (preferred over confirmColor) */
  confirmVariant?: ButtonProps["variant"];
  /** Override the confirm button color (default: "bg-brutal-red" for destructive actions) */
  confirmColor?: string;
  /** Hide the secondary cancel action for informational acknowledgement dialogs. */
  hideCancel?: boolean;
  /** Stacking layer (0 = default z-50, 1 = z-60 for nested dialogs) */
  layer?: number;
  /** Optional test id for the confirm button (e2e selection) */
  confirmTestId?: string;
  /** Let parent-managed flows keep the dialog open after an async confirm. */
  closeOnConfirm?: boolean;
  /** Width utility for dialogs with richer body content. */
  maxWidthClass?: string;
  /** Render interactive/rich body content without the default warning banner frame. */
  plainMessage?: boolean;
  /** Compact actions for confirmations embedded in already-dense surfaces. */
  actionSize?: "xs" | "sm";
  /** Caller-owned semantic foreground override for the confirm action. */
  confirmClassName?: string;
  /**
   * Locale for the dialog-owned chrome (Cancel, close labels, default loading
   * and fallback error). Defaults to `active`: every caller's own copy is
   * migrated, so the chrome follows the display locale. The old English
   * default (#5117, partial rollout) left a Chinese dialog with an English
   * "Cancel" whenever a caller forgot to opt in. Pass an explicit locale for an
   * independently localized surface such as the billing WebView.
   */
  chromeLocale?: Locale | "active";
}

const CONFIRM_TONES_BY_LEGACY_COLOR: Record<string, ButtonProps["variant"]> = {
  "bg-white": "outline",
  "bg-soft-signal": "primary",
  "bg-brutal-pink": "accent",
  "bg-brutal-cyan": "information",
  "bg-brutal-lavender": "muted",
  "bg-brutal-orange": "warning",
  "bg-brutal-lime": "success",
  "bg-brutal-red": "danger",
  "bg-brutal-stone": "muted",
};

/**
 * Unified confirmation dialog for destructive actions.
 * Shows one concise explanation followed by Cancel / Confirm actions.
 */
export default function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  loadingLabel,
  confirmIcon,
  onConfirm,
  onClose,
  confirmDisabled = false,
  confirmVariant,
  confirmColor,
  hideCancel = false,
  layer,
  confirmTestId,
  closeOnConfirm = true,
  maxWidthClass = "max-w-sm",
  plainMessage = false,
  actionSize = "sm",
  confirmClassName,  chromeLocale = "active",
}: ConfirmDialogProps) {
  const { formatMessage } = useIntl();
  const fixedChromeMessages = chromeLocale === "active" ? null : mergedMessages(chromeLocale);
  const formatChromeMessage = (id: MessageId) => fixedChromeMessages?.[id] ?? formatMessage({ id });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Caller-supplied labels win; otherwise fall back within the caller's
  // declared composition boundary.
  const resolvedConfirmLabel = confirmLabel ?? formatChromeMessage("common.confirm.defaultConfirmLabel");
  const resolvedProcessing = loadingLabel ?? formatChromeMessage("common.confirm.processing");
  const resolvedProcessingEllipsis = loadingLabel ?? formatChromeMessage("common.confirm.processingEllipsis");
  const confirmTone = confirmVariant ?? (confirmColor ? CONFIRM_TONES_BY_LEGACY_COLOR[confirmColor] : undefined) ?? "danger";

  const handleClose = () => {
    if (!loading) onClose();
  };

  const handleConfirm = async () => {
    setLoading(true);
    setError(null);
    try {
      await onConfirm();
      if (closeOnConfirm) {
        onClose();
      } else {
        setLoading(false);
      }
    } catch (err) {
      setLoading(false);
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(
        axiosErr.response?.data?.error ||
          (err instanceof Error ? err.message : formatChromeMessage("common.confirm.somethingWentWrong")),
      );
    }
  };

  return (
    <Dialog
      open
      // The old Modal frame never closed on a backdrop press for confirmations
      // (closeOnBackdrop stayed false) — keep that: only Escape, the close
      // button and Cancel dismiss, all gated on the in-flight confirm.
      disablePointerDismissal
      onOpenChange={(nextOpen) => {
        if (!nextOpen) handleClose();
      }}
    >
      <DialogContent
        layer={(layer ?? 0) >= 1 ? 1 : 0}
        className={maxWidthClass}
        aria-modal="true"
        aria-busy={loading}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogClose
            disabled={loading}
            aria-label={formatChromeMessage(
              loading ? "common.confirm.actionInProgress" : "common.confirm.closeDialog",
            )}
          />
        </DialogHeader>

        {/* font-normal matches the sibling JointConversionConfirmDialog: the
            rui brutal body recipe is font-medium, but confirmation copy was
            regular-weight under the old frame. */}
        <DialogBody className="font-normal">
          {/* The title establishes the action and this is its one explanation.
              Repeating the same warning inside a second coloured panel made
              confirmations read like two competing pieces of content. Rich
              callers retain their own layout; ordinary copy gets the shared
              compact text treatment. */}
          {/* No bottom margin on the body wrapper: the rui Dialog recipe
              already spaces body and footer; a leftover mb-* here doubled the
              gap (Josh's review measurement on #8468). */}
          <div
            className={plainMessage ? undefined : "text-sm leading-relaxed text-foreground-muted"}
            data-slot="confirm-dialog-content"
          >
            {message}
          </div>

          {/* Error */}
          {error && (
            <Banner intent="warning" className="mt-4">
              {error}
            </Banner>
          )}
        </DialogBody>

        <DialogFooter className="flex-wrap">
          {!hideCancel && (
            <Button
              onClick={handleClose}
              disabled={loading}
              size={actionSize}
              variant="outline"
              className="whitespace-nowrap disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-30"
            >
              {cancelLabel ?? formatChromeMessage("common.confirm.cancel")}
            </Button>
          )}
          <Button
            data-testid={confirmTestId}
            onClick={handleConfirm}
            disabled={loading || confirmDisabled}
            size={actionSize}
            variant={confirmTone}
            className={`whitespace-nowrap disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-80 ${confirmClassName ?? ""}`.trim()}
            aria-busy={loading}
            aria-label={loading ? resolvedProcessingEllipsis : undefined}
          >
            {loading && <Spinner size="xs" aria-label={resolvedProcessing} />}
            {!loading && confirmIcon}
            {loading ? resolvedProcessingEllipsis : resolvedConfirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
