import { DISTRIBUTION_POLICY } from "@botiverse/raft-shared/src/distributionPolicy";
import { useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { trackEvent } from "../analytics/track";
import {
  CHINESE_COMMUNITY_QR_FALLBACK_CONFIG_PATH,
  getChineseCommunityQrConfigUrl,
  isChineseCommunityQrExpired,
  resolveChineseCommunityQrConfig,
} from "../utils/chineseCommunityQr";
import type { ChineseCommunityQrConfig } from "../utils/chineseCommunityQr";
import { useBrowserDocumentTitle } from "../utils/browserDocumentTitle";

type QrState =
  | { status: "loading" }
  | { status: "ready"; config: ChineseCommunityQrConfig; source: "primary" | "fallback" }
  | { status: "missing"; reason: "config" | "image" };

function qrUnavailableMessageId(state: QrState, expired: boolean, imageLoadFailed: boolean) {
  if (state.status === "missing") {
    return state.reason === "image"
      ? "pages.chineseCommunity.unavailableQr"
      : "pages.chineseCommunity.missingQr";
  }
  if (expired) return "pages.chineseCommunity.expiredQr";
  if (imageLoadFailed) return "pages.chineseCommunity.unavailableQr";
  return "pages.chineseCommunity.missingQr";
}

export default function ChineseCommunityPage() {
  const { formatMessage } = useIntl();
  const [state, setState] = useState<QrState>({ status: "loading" });
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const configUrl = useMemo(() => getChineseCommunityQrConfigUrl(), []);
  const from = useMemo(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("from") || "direct";
  }, []);

  useBrowserDocumentTitle(formatMessage({ id: "pages.chineseCommunity.title" }));

  const fetchConfig = async (url: string) => {
    if (!DISTRIBUTION_POLICY.upstreamServices) return null;
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) return null;
      return resolveChineseCommunityQrConfig(await response.json(), url);
    } catch {
      return null;
    }
  };

  const loadFallbackConfig = async (missingReason: "config" | "image" = "config") => {
    const fallback = await fetchConfig(CHINESE_COMMUNITY_QR_FALLBACK_CONFIG_PATH);
    setState(
      fallback
        ? { status: "ready", config: fallback, source: "fallback" }
        : { status: "missing", reason: missingReason },
    );
    setFailedImageUrl(null);
  };

  const loadConfig = async () => {
    setState({ status: "loading" });
    setFailedImageUrl(null);
    const primary = await fetchConfig(configUrl);
    if (primary) {
      setState({ status: "ready", config: primary, source: "primary" });
      return;
    }
    await loadFallbackConfig();
  };

  useEffect(() => {
    trackEvent("community_cn_qr_page_view", { from });
    void loadConfig();
    // `loadConfig` intentionally reads the memoized config URL only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configUrl, from]);

  const config = state.status === "ready" ? state.config : null;
  const expired = config ? isChineseCommunityQrExpired(config.expiresAt) : false;
  const imageLoadFailed = Boolean(config && failedImageUrl === config.imageUrl);
  const showQrImage = Boolean(config && !expired && !imageLoadFailed);
  const unavailableMessageId = qrUnavailableMessageId(state, expired, imageLoadFailed);

  return (
    <main className="h-dvh overflow-hidden bg-layer-canvas-muted px-4 font-display text-foreground-strong safe-top safe-bottom theme-brutal:bg-brutal-cream theme-brutal:text-black">
      <div className="mx-auto flex h-full w-full max-w-sm flex-col items-center justify-center gap-5 text-center">
        <h1 className="text-2xl font-black leading-tight sm:text-3xl">
          {formatMessage({ id: "pages.chineseCommunity.title" })}
        </h1>

        <section
          aria-label={formatMessage({ id: "pages.chineseCommunity.qrLabel" })}
          className="w-full max-w-[20rem] rounded-lg border border-line-muted bg-layer-panel p-3 shadow-raft-md theme-brutal:rounded-none theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white theme-brutal:shadow-brutal sm:p-4"
        >
          <div className="mx-auto grid aspect-square w-full place-items-center rounded-md border border-line-muted bg-layer-inset theme-brutal:rounded-none theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-brutal-cream">
            {state.status === "loading" ? (
              <div
                data-testid="chinese-community-qr-loading"
                className="size-40 animate-pulse rounded-md border border-line-muted bg-layer-panel theme-brutal:rounded-none theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white"
              />
            ) : showQrImage && config ? (
              <img
                src={config.imageUrl}
                alt={formatMessage({ id: "pages.chineseCommunity.qrAlt" })}
                width={288}
                height={288}
                decoding="sync"
                onError={() => {
                  if (state.status === "ready" && state.source === "primary") {
                    void loadFallbackConfig("image");
                    return;
                  }
                  setFailedImageUrl(config.imageUrl);
                }}
                data-testid="chinese-community-qr-image"
                className="size-full object-contain [image-rendering:pixelated]"
              />
            ) : (
              <div
                role="status"
                data-testid="chinese-community-qr-missing"
                className="px-5 text-sm font-bold leading-6 text-foreground-muted"
              >
                {formatMessage({ id: unavailableMessageId })}
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
