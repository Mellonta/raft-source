import { Banner, BannerAction, BannerDescription, Button, Card, PanelHeader, PanelHeading, PanelTitle } from "raft-ui";
import { useIntl } from "react-intl";
import RootFallbackScroller from "./RootFallbackScroller";

export function AppRefreshRequiredScreen({
  onContinueAnyway,
  onRecoverAndRefresh,
}: {
  onContinueAnyway: () => void;
  onRecoverAndRefresh: () => void;
}) {
  const { formatMessage } = useIntl();

  return (
    <RootFallbackScroller className="flex min-h-full items-center justify-center bg-layer-canvas p-6 font-display safe-top safe-bottom theme-brutal:bg-brutal-cream">
      <Card
        role="alert"
        aria-live="assertive"
        className="w-full max-w-md border border-line-muted bg-layer-panel p-6 shadow-raft-lg theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white theme-brutal:shadow-brutal"
      >
        <PanelHeader className="mb-4 -mx-6 -mt-6 border-b border-line-muted px-6 py-4 theme-brutal:border-b-2 theme-brutal:border-black theme-brutal:bg-soft-signal">
          <PanelHeading>
            <PanelTitle
              render={
                <h1 className="text-xl font-black text-foreground-strong theme-brutal:text-black">
                  {formatMessage({ id: "app.update.refreshToContinue" })}
                </h1>
              }
            />
          </PanelHeading>
        </PanelHeader>
        <p className="m-0 text-sm leading-relaxed text-foreground-muted theme-brutal:text-black/80">
          {formatMessage({ id: "app.update.staleBuildBody" })}
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
          <Button
            variant="outline"
            size="md"
            type="button"
            onClick={onContinueAnyway}
            className="font-bold"
          >
            {formatMessage({ id: "app.update.continueAnyway" })}
          </Button>
          <Button
            variant="accent"
            size="md"
            type="button"
            onClick={onRecoverAndRefresh}
            className="font-black"
          >
            {formatMessage({ id: "app.update.refreshNow" })}
          </Button>
        </div>
      </Card>
    </RootFallbackScroller>
  );
}


export function AppRefreshWarningBanner({ onRefresh }: { onRefresh: () => void }) {
  const { formatMessage } = useIntl();

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-3 left-1/2 z-40 w-[min(calc(100%-24px),560px)] -translate-x-1/2"
    >
      <Banner
        status="warning"
        size="md"
        className="shadow-raft-md theme-brutal:shadow-brutal-sm"
      >
        <BannerDescription>
          {formatMessage({ id: "app.update.newerVersionAvailable" })}
        </BannerDescription>
        <BannerAction>
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={onRefresh}
            className="font-bold whitespace-nowrap"
          >
            {formatMessage({ id: "app.update.refresh" })}
          </Button>
        </BannerAction>
      </Banner>
    </div>
  );
}

