import { useIntl } from "react-intl";
import type { MigrationErrorPresentation } from "./errors";

export function MigrationErrorContent({ presentation }: { presentation: MigrationErrorPresentation }) {
  const { formatMessage } = useIntl();
  return (
    <div className="space-y-1.5">
      {presentation.placement ? <div className="font-bold">{presentation.placement}</div> : null}
      <div>{presentation.message}</div>
      {presentation.issues?.length ? (
        <ul className="list-disc space-y-1 pl-5">
          {presentation.issues.map((issue, index) => <li key={`${index}:${issue}`}>{issue}</li>)}
        </ul>
      ) : null}
      {presentation.technicalCode || presentation.diagnosticRef ? (
        <details className="text-xs text-foreground-muted theme-brutal:text-black/60">
          <summary className="font-bold">{formatMessage({ id: "agent.detail.technicalDetails" })}</summary>
          <div className="space-y-0.5">
            {presentation.technicalCode ? (
              <div>
                {formatMessage({ id: "agent.detail.technicalErrorCode" })}: {" "}
                <code>{presentation.technicalCode}</code>
              </div>
            ) : null}
            {presentation.diagnosticRef ? (
              <div>
                {formatMessage({ id: "agent.detail.diagnosticReference" })}: {" "}
                <code>{presentation.diagnosticRef}</code>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}
