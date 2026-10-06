import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";
import { useIntl } from "react-intl";
import type { ReactNode } from "react";

import { Checkbox } from "raft-ui";

export default function LegalAcceptanceCheckbox({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const { formatMessage } = useIntl();
  return (
    <label className="flex items-start gap-2.5 text-sm">
      <Checkbox
        size="md"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(event) => onChange(event)}
        className="mt-0.5"
      />
      <span className="leading-5 text-foreground-muted">
        {formatMessage(
          { id: "auth.legalAcceptance.agreement" },
          {
            terms: (c: ReactNode) => (
              <a
                key="terms"
                href={CURRENT_LEGAL_ACCEPTANCE.termsUrl}
                target="_blank"
                rel="noreferrer"
                className="font-bold text-foreground-strong underline hover:text-accent-strong theme-brutal:hover:text-brutal-pink"
              >
                {c}
              </a>
            ),
            privacy: (c: ReactNode) => (
              <a
                key="privacy"
                href={CURRENT_LEGAL_ACCEPTANCE.privacyUrl}
                target="_blank"
                rel="noreferrer"
                className="font-bold text-foreground-strong underline hover:text-accent-strong theme-brutal:hover:text-brutal-pink"
              >
                {c}
              </a>
            ),
          },
        )}
      </span>
    </label>
  );
}
