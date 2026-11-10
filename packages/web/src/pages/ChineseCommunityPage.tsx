import { browserPrivacyMode } from "@botiverse/raft-shared/src/browserPrivacy";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { Card } from "@botiverse/raft-ui";
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

async function fetchConfig(url: string) {
  if (browserPrivacyMode()) return null;
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    return resolveChineseCommunityQrConfig(await response.json(), url);
  } catch {
    return null;
  }
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

  const loadFallbackConfig = useCallback(async (missingReason: "config" | "image" = "config") => {
    const fallback = await fetchConfig(CHINESE_COMMUNITY_QR_FALLBACK_CONFIG_PATH);
    setState(
      fallback
        ? { status: "ready", config: fallback, source: "fallback" }
        : { status: "missing", reason: missingReason },
    );
    setFailedImageUrl(null);
  }, []);

  const loadConfig = useCallback(async () => {
    setState({ status: "loading" });
    setFailedImageUrl(null);
    const primary = await fetchConfig(configUrl);
    if (primary) {
      setState({ status: "ready", config: primary, source: "primary" });
      return;
    }
    await loadFallbackConfig();
  }, [configUrl, loadFallbackConfig]);

  // `loadConfig` only changes with the memoized config URL, so this runs once per mount.
  useEffect(() => {
    trackEvent("community_cn_qr_page_view", { from });
    void loadConfig();
  }, [from, loadConfig]);

  const config = state.status === "ready" ? state.config : null;
  const expired = config ? isChineseCommunityQrExpired(config.expiresAt) : false;
  const imageLoadFailed = Boolean(config && failedImageUrl === config.imageUrl);
  const showQrImage = Boolean(config && !expired && !imageLoadFailed);
  const unavailableMessageId = qrUnavailableMessageId(state, expired, imageLoadFailed);

  return (
    <main className="h-dvh overflow-hidden bg-layer-sidebar px-4 font-display text-foreground safe-top safe-bottom">
      <div className="mx-auto flex h-full w-full max-w-sm flex-col items-center justify-center gap-5 text-center">
        <h1 className="text-title sm:text-display">
          {formatMessage({ id: "pages.chineseCommunity.title" })}
        </h1>

        <Card
          aria-label={formatMessage({ id: "pages.chineseCommunity.qrLabel" })}
          render={<section />}
          className="w-full max-w-[20rem] shrink-0 p-3 sm:p-4"
        >
          <div className="mx-auto grid aspect-square w-full place-items-center overflow-hidden rounded-control border border-line-hairline bg-layer-canvas">
            {state.status === "loading" ? (
              <div
                data-testid="chinese-community-qr-loading"
                className="size-40 animate-pulse rounded-sticker bg-fill-muted"
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
                className="px-5 text-callout font-semibold text-foreground-muted"
              >
                {formatMessage({ id: unavailableMessageId })}
              </div>
            )}
          </div>
        </Card>
      </div>
    </main>
  );
}
