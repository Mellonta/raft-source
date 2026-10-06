import { Card, Button } from "raft-ui";
import CloseButton from "../ui/CloseButton";
import Tooltip from "../ui/Tooltip";
import { useState } from "react";
import { useIntl } from "react-intl";
import { X } from "lucide-react";
import Modal from "../Modal";
import Banner from "../ui/Banner";
import AgreementBody from "./AgreementBody";

export interface CommunityAgreement {
  id: string;
  title: string;
  bodyMarkdown: string;
  version: number;
}

export default function CommunityAgreementDialog({
  agreement,
  onClose,
  onAgree,
}: {
  agreement: CommunityAgreement;
  onClose: () => void;
  onAgree: (agreementId: string) => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleAgree = async () => {
    setSubmitting(true);
    setError("");
    try {
      await onAgree(agreement.id);
    } catch (err: any) {
      const response = err?.response?.data;
      setError(
        response?.error === "agreement_changed"
          ? formatMessage({ id: "server.communityAgreement.updated" })
          : formatMessage({ id: "server.communityAgreement.failedToJoin" }),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <Card className="w-full max-w-lg p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">{agreement.title}</h2>
            <div className="mt-0.5 text-xs text-foreground-muted theme-brutal:text-black/50">
              {formatMessage({ id: "server.communityAgreement.version" }, { version: agreement.version })}
            </div>
          </div>
          <Tooltip content={formatMessage({ id: "common.close" })}>
            <CloseButton
              type="button"
              onClick={onClose}
              className="shrink-0"
              data-slot="button"
            >
              <X size={18} />
            </CloseButton>
          </Tooltip>
        </div>

        <div className="max-h-[50vh] overflow-y-auto border-2 border-line-muted theme-brutal:border-black bg-layer-panel theme-brutal:bg-white p-4 text-sm">
          <AgreementBody source={agreement.bodyMarkdown} />
        </div>

        {error && (
          <Banner intent="warning" density="sm" className="mt-4 font-bold">
            {error}
          </Banner>
        )}

        <div className="mt-5 flex justify-end gap-3">
          <Button size="sm"
            variant="outline"
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 text-xs disabled:opacity-50"
          >
            {formatMessage({ id: "server.communityAgreement.cancel" })}
          </Button>
          <Button size="sm"
            variant="accent"
            type="button"
            onClick={handleAgree}
            disabled={submitting}
            className="px-3 py-1.5 text-xs disabled:opacity-50"
          >
            {submitting
              ? formatMessage({ id: "server.communityAgreement.joining" })
              : formatMessage({ id: "server.communityAgreement.agreeContinue" })}
          </Button>
        </div>
      </Card>
    </Modal>
  );
}
