import { Button, Card, CardContent, CardHeader, CardTitle } from "raft-ui";
import { useIntl } from "react-intl";
import RootFallbackScroller from "./RootFallbackScroller";

export default function RootErrorFallback({
  error,
  componentStack,
}: {
  error: Error;
  componentStack?: string | null;
}) {
  const { formatMessage } = useIntl();

  return (
    <RootFallbackScroller className="flex min-h-full items-center justify-center bg-layer-canvas p-6 font-display safe-top safe-bottom theme-brutal:bg-brutal-cream">
      <Card
        className="w-full max-w-2xl border border-line-muted bg-layer-panel shadow-raft-lg theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white theme-brutal:shadow-brutal"
        role="alert"
        aria-live="assertive"
      >
        <CardHeader className="border-b border-line-muted px-6 py-4 theme-brutal:border-b-2 theme-brutal:border-black theme-brutal:bg-soft-signal">
          <CardTitle
            render={
              <h1 className="text-xl font-bold text-foreground-strong theme-brutal:text-black">
                {formatMessage({ id: "errorBoundary.title" })}
              </h1>
            }
          />
        </CardHeader>

        <CardContent className="p-6">
          <div className="mb-4 rounded-md border border-line-muted bg-layer-inset p-3 font-mono text-sm leading-relaxed text-foreground-strong theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white">
            <pre className="whitespace-pre-wrap break-words">{error.message}</pre>
          </div>

          {error.stack ? (
            <details className="mb-4 rounded-md border border-line-muted bg-layer-inset p-3 text-xs text-foreground-muted theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white">
              <summary className="font-bold text-foreground-strong theme-brutal:text-black">
                {formatMessage({ id: "errorBoundary.stack" })}
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono">
                {error.stack}
              </pre>
            </details>
          ) : null}

          {componentStack ? (
            <details open className="mb-4 rounded-md border border-line-muted bg-layer-inset p-3 text-xs text-foreground-muted theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white">
              <summary className="font-bold text-foreground-strong theme-brutal:text-black">
                {formatMessage({ id: "errorBoundary.componentStack" })}
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono">
                {componentStack}
              </pre>
            </details>
          ) : null}

          <div className="mt-6 flex justify-end">
            <Button
              variant="accent"
              size="md"
              onClick={() => window.location.reload()}
              className="font-bold"
            >
              {formatMessage({ id: "errorBoundary.reloadApp" })}
            </Button>
          </div>
        </CardContent>
      </Card>
    </RootFallbackScroller>
  );
}
