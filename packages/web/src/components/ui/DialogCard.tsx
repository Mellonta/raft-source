import CloseButton from "./CloseButton";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { Card, CardHeader, CardTitle } from "raft-ui";
import Modal from "../Modal";

export default function DialogCard({
  title,
  titleId,
  onClose,
  children,
  maxWidthClass = "max-w-md",
  testId,
  closeOnBackdrop = false,
  layer,
}: {
  title: ReactNode;
  titleId?: string;
  onClose: () => void;
  children: ReactNode;
  maxWidthClass?: string;
  testId?: string;
  /** Stacking tier forwarded to Modal (0 → z-50, 1 → z-60, >=2 → z-70).
   *  Needed when the card opens from inside another modal (for example the
   *  agent detail runtime editor) so it lands above the parent instead of
   *  behind it. */
  layer?: number;
  /** Passed through because some callers close on backdrop and some must not.
   *  Without it, adopting this shell would silently take backdrop-close away
   *  from a dialog that had it — a behaviour change wearing a refactor's
   *  clothes. Defaults to the previous behaviour of this component. */
  closeOnBackdrop?: boolean;
}) {
  const { formatMessage } = useIntl();
  return (
    <Modal onClose={onClose} closeOnBackdrop={closeOnBackdrop} {...(layer !== undefined ? { layer } : {})}>
      <Card className={`w-full ${maxWidthClass} p-6`} data-testid={testId}>
        <CardHeader className="mb-4 flex items-center justify-between border-b-0 p-0">
          <CardTitle render={<h2 id={titleId}>{title}</h2>} className="text-lg font-bold uppercase" />
          <CloseButton
            type="button"
            onClick={onClose}
            aria-label={formatMessage({ id: "common.close" })}
          >
            <X size={20} />
          </CloseButton>
        </CardHeader>
        {children}
      </Card>
    </Modal>
  );
}
