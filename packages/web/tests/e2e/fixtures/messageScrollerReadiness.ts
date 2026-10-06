import { expect } from "@playwright/test";
import type { JSHandle, Page, Request, Response, TestInfo } from "@playwright/test";
import {
  evidenceConfig,
  readApiRequestOccupancyEvidence,
  readReadinessServerEvidence,
  traceIdFromTraceparent,
} from "../../../../../scripts/e2e/transportEvidence";

export const MESSAGE_SCROLLER_READINESS_TIMEOUT_MS = 5_000;

const MAX_MATCHED_REQUESTS = 8;

export type MessageScrollerReadinessConsumer = "unread-click-read" | "channel-task-board";
export type MessageScrollerRequestKind = "dm-channels" | "channel" | "messages";
export type MessageScrollerRenderStage =
  | "route-loading"
  | "message-loading"
  | "rendered"
  | "unknown";

type RouteKind = "channel" | "dm" | "other";

interface RenderStageSample {
  atMs: number;
  stage: MessageScrollerRenderStage;
  scrollerCount: number;
}

interface BrowserStageEvidence {
  samples: RenderStageSample[];
  final: RenderStageSample & {
    routeKind: RouteKind;
    routeChannelId: string | null;
    routeMatchesTarget: boolean;
  };
}

interface BrowserStageProbe {
  stopAndRead: () => BrowserStageEvidence;
}

interface RequestLifecycleEntry {
  id: number;
  kind: MessageScrollerRequestKind;
  startedAtMs: number;
  traceCorrelationState: "available" | "unavailable";
  traceId?: string;
  responseAtMs?: number;
  status?: number;
  finishedAtMs?: number;
  failedAtMs?: number;
  failureKind?: "aborted" | "connection-reset" | "connection-refused" | "timeout" | "other";
}

type ReadinessTestInfo = Pick<TestInfo, "attach" | "retry">;

interface ReadinessTarget {
  consumer: MessageScrollerReadinessConsumer;
  channelId: string;
}

function decodedPathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Match the exact target GETs plus the competing DM-list hydrate; never retain a URL or query. */
export function classifyMessageScrollerRequest(
  method: string,
  rawUrl: string,
  targetChannelId: string,
): MessageScrollerRequestKind | null {
  if (method !== "GET") return null;
  let pathname: string;
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    return null;
  }

  if (pathname === "/api/channels/dm") return "dm-channels";

  const match = pathname.match(/^\/api\/(channels|messages\/channel)\/([^/]+)$/);
  if (!match || decodedPathSegment(match[2]) !== targetChannelId) return null;
  return match[1] === "channels" ? "channel" : "messages";
}

function classifyRequestFailure(errorText: string | undefined) {
  const normalized = errorText?.toLowerCase() ?? "";
  if (normalized.includes("aborted")) return "aborted" as const;
  if (normalized.includes("reset")) return "connection-reset" as const;
  if (normalized.includes("refused")) return "connection-refused" as const;
  if (normalized.includes("timeout") || normalized.includes("timed out")) return "timeout" as const;
  return "other" as const;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

async function startBrowserStageProbe(
  page: Page,
  targetChannelId: string,
  receiptStartedAtEpochMs: number,
): Promise<JSHandle<BrowserStageProbe>> {
  // Playwright serializes function callbacks after the test transform. A string
  // expression avoids transform-only helpers (for example `__name`) leaking
  // into the browser context and making the diagnostic itself unavailable.
  const expression = `(() => {
    const expectedChannelId = ${JSON.stringify(targetChannelId)};
    const receiptStartedAtEpochMs = ${JSON.stringify(receiptStartedAtEpochMs)};
    const samples = [];
    let lastKey = "";

    const read = () => {
      // Limit message loading/scroller detection to the actual content surface.
      // The surrounding column also contains the channel header, whose ordinary
      // title text must not be mistaken for a route-loading state.
      const targetSurface = document.querySelector('[data-testid="thread-main-column"]');
      const messageSurface = targetSurface?.querySelector('[data-testid="message-content-surface"]') ?? null;
      const scrollerCount = messageSurface?.querySelectorAll('[data-testid="message-scroller"]').length ?? 0;
      const routeText = messageSurface ? "" : targetSurface?.innerText ?? "";
      const messageText = messageSurface?.innerText ?? "";
      const stage = scrollerCount > 0
        ? "rendered"
        : routeText.includes("Loading channel")
          ? "route-loading"
          : messageText.includes("Loading…") || messageText.includes("Loading...")
            ? "message-loading"
            : "unknown";
      return {
        // Request listeners and this DOM probe share the receipt-start epoch,
        // so their lifecycle events can be ordered in one timeline.
        atMs: Math.max(0, Date.now() - receiptStartedAtEpochMs),
        stage,
        scrollerCount,
      };
    };

    const recordTransition = () => {
      const sample = read();
      const key = sample.stage + ":" + sample.scrollerCount;
      if (key === lastKey || samples.length >= 12) return;
      lastKey = key;
      samples.push(sample);
    };

    const observer = new MutationObserver(recordTransition);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    recordTransition();

    return {
      stopAndRead() {
        observer.disconnect();
        recordTransition();
        const final = read();
        const routeParts = location.pathname.split("/").filter(Boolean);
        const routeKind = routeParts.at(-2);
        let routeChannelId = null;
        if (routeKind === "channel" || routeKind === "dm") {
          try {
            routeChannelId = decodeURIComponent(routeParts.at(-1) ?? "");
          } catch {
            routeChannelId = null;
          }
        }
        return {
          samples,
          final: {
            ...final,
            routeKind: routeKind === "channel" || routeKind === "dm" ? routeKind : "other",
            routeChannelId,
            routeMatchesTarget: routeChannelId === expectedChannelId,
          },
        };
      },
    };
  })()`;
  return page.evaluateHandle(expression) as Promise<JSHandle<BrowserStageProbe>>;
}

/**
 * Observe one readiness assertion without changing its result. Only a failure
 * emits a bounded, header/body-free attachment; all diagnostic errors remain
 * secondary to the original assertion error.
 */
export async function withMessageScrollerReadinessEvidence<T>(
  page: Page,
  testInfo: ReadinessTestInfo,
  target: ReadinessTarget,
  action: (startRenderObservation: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const requests: RequestLifecycleEntry[] = [];
  const requestEntries = new Map<Request, RequestLifecycleEntry>();
  let browserProbe: JSHandle<BrowserStageProbe> | null = null;
  let browserProbeAvailable = false;
  let browserProbeRequested = false;
  let requestObserverAvailable = false;

  const onRequest = (request: Request) => {
    const kind = classifyMessageScrollerRequest(request.method(), request.url(), target.channelId);
    if (!kind || requests.length >= MAX_MATCHED_REQUESTS) return;
    let traceId: string | null = null;
    try {
      traceId = traceIdFromTraceparent(request.headers().traceparent);
    } catch {
      // Correlation is optional diagnostic evidence; request observation remains useful without it.
    }
    const entry: RequestLifecycleEntry = {
      id: requests.length + 1,
      kind,
      startedAtMs: elapsedMs(startedAt),
      traceCorrelationState: traceId ? "available" : "unavailable",
      ...(traceId ? { traceId } : {}),
    };
    requests.push(entry);
    requestEntries.set(request, entry);
  };
  const onResponse = (response: Response) => {
    const entry = requestEntries.get(response.request());
    if (!entry) return;
    entry.responseAtMs = elapsedMs(startedAt);
    entry.status = response.status();
  };
  const onFinished = (request: Request) => {
    const entry = requestEntries.get(request);
    if (entry) entry.finishedAtMs = elapsedMs(startedAt);
  };
  const onFailed = (request: Request) => {
    const entry = requestEntries.get(request);
    if (!entry) return;
    entry.failedAtMs = elapsedMs(startedAt);
    entry.failureKind = classifyRequestFailure(request.failure()?.errorText);
  };

  try {
    page.on("request", onRequest);
    page.on("response", onResponse);
    page.on("requestfinished", onFinished);
    page.on("requestfailed", onFailed);
    requestObserverAvailable = true;
  } catch {
    // A missing request observer must not prevent navigation or the assertion.
  }

  const startRenderObservation = async () => {
    if (browserProbeRequested) return;
    browserProbeRequested = true;
    try {
      browserProbe = await startBrowserStageProbe(page, target.channelId, startedAt);
      browserProbeAvailable = true;
    } catch {
      // A missing DOM observer must not prevent the product assertion.
    }
  };

  let assertionSucceeded = false;
  let assertionResult: T | undefined;
  let assertionError: unknown;
  try {
    assertionResult = await action(startRenderObservation);
    assertionSucceeded = true;
  } catch (error) {
    assertionError = error;
  }
  const assertionEndedAtMs = elapsedMs(startedAt);

  let browser: BrowserStageEvidence | null = null;
  if (browserProbe) {
    browser = await browserProbe.evaluate((probe) => probe.stopAndRead()).catch(() => null);
    await browserProbe.dispose().catch(() => undefined);
  }

  try {
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("requestfinished", onFinished);
    page.off("requestfailed", onFailed);
  } catch {
    // Listener cleanup is diagnostic-only and cannot change the assertion.
  }

  if (assertionSucceeded) return assertionResult as T;

  const traceIds = requests.flatMap((request) => request.traceId ? [request.traceId] : []);
  const rawServerEvidence = readReadinessServerEvidence(evidenceConfig(), traceIds);
  const serverEvidence = rawServerEvidence.state === "matched"
    ? {
        state: rawServerEvidence.state,
        source: "playwright-node-api-server-http-events",
        retention: "copied-into-failure-attachment",
        records: rawServerEvidence.records.map((record) => ({
          traceId: record.traceId,
          kind: record.requestKind,
          stage: record.stage,
          atMs: Math.max(0, record.atEpochMs - startedAt),
          ...(record.status !== undefined ? { status: record.status } : {}),
          ...(record.finished !== undefined ? { finished: record.finished } : {}),
        })),
        interpretation: {
          arrival: "the Node API server HTTP listener emitted its request event",
          responseFinished: "Node emitted response finish after handing the response to its transport; browser receipt is not proven",
          missingStage: "missing stages do not establish that a request or response did not occur",
        },
      }
    : {
        state: rawServerEvidence.state,
        source: "playwright-node-api-server-http-events",
        ...(rawServerEvidence.state === "unavailable" ? { reason: rawServerEvidence.reason } : {}),
        records: [],
        interpretation: "missing server evidence does not establish that the request did not arrive",
      };

  const rawApiOccupancy = readApiRequestOccupancyEvidence(
    evidenceConfig(),
    requests.flatMap((request) => request.traceId ? [{
      traceId: request.traceId,
      clientStartedAtEpochMs: startedAt + request.startedAtMs,
      assertionEndedAtEpochMs: startedAt + assertionEndedAtMs,
    }] : []),
  );
  const apiOccupancy = rawApiOccupancy.state === "matched"
    ? {
        state: rawApiOccupancy.state,
        coverage: rawApiOccupancy.coverage,
        source: "playwright-node-api-server-anonymous-request-events",
        snapshots: rawApiOccupancy.snapshots.map((snapshot) => ({
          traceId: snapshot.traceId,
          clientStartedAtMs: Math.max(0, snapshot.clientStartedAtEpochMs - startedAt),
          atClientStart: snapshot.atClientStart,
          targetServerRequest: snapshot.targetServerRequest,
          releasesBeforeAssertionEnd: snapshot.releasesBeforeAssertionEnd,
          releasesTruncated: snapshot.releasesTruncated,
        })),
        interpretation: {
          active: "Node observed these API requests begin without a request terminal, connection close, or process exit before this browser request start",
          known: "known means retained lifecycle is continuous from every observed server process start or a complete bounded occupancy checkpoint, and every observed active request has anonymous connection correlation",
          unknown: "unknown counts only retained observations; they do not establish the complete active-request or connection count",
          releaseOrder: "first retained request terminal, connection close, or process exit for each request that was active at browser request start",
          releasesTruncated: "number of additional matching releases omitted after the bounded detail limit",
          targetNotObserved: "the browser request existed, but no matching Node API request-begin event was retained before attachment capture; this is not proof of permanent non-arrival",
          partialRetention: "missing process-start/checkpoint coverage, a truncated checkpoint, or a sequence gap makes occupancy unknown even when an observed count is zero",
        },
      }
    : {
        state: rawApiOccupancy.state,
        source: "playwright-node-api-server-anonymous-request-events",
        ...(rawApiOccupancy.state === "unavailable" ? { reason: rawApiOccupancy.reason } : {}),
        snapshots: [],
        interpretation: "missing occupancy evidence does not establish that no API requests or occupied connections existed",
      };

  const receipt = {
    schema: "message-scroller-readiness",
    version: 2,
    consumer: target.consumer,
    retry: testInfo.retry,
    targetChannelId: target.channelId,
    timeoutMs: MESSAGE_SCROLLER_READINESS_TIMEOUT_MS,
    timeline: {
      origin: "receipt-start-before-navigation",
      unit: "ms",
    },
    assertionEndedAtMs,
    requestObserverAvailable,
    browser: browser ?? {
      available: false,
      reason: browserProbeAvailable
        ? "capture-unavailable"
        : browserProbeRequested
          ? "observer-unavailable"
          : "observer-not-started",
    },
    requests,
    requestEvidence: {
      source: "playwright-page-request-events",
      interpretation: "client-side observation only; a request event is not server arrival evidence",
    },
    serverEvidence,
    apiOccupancy,
    unavailable: ["message-store-state", "receiver-ingress-generation"],
  };

  try {
    await testInfo.attach(`message-scroller-readiness-${target.consumer}.json`, {
      body: Buffer.from(JSON.stringify(receipt, null, 2)),
      contentType: "application/json",
    });
  } catch {
    console.error("[message-scroller-readiness] diagnostic attachment unavailable");
  }
  throw assertionError;
}

export async function navigateToMessageScrollerWithReadinessEvidence(
  page: Page,
  testInfo: ReadinessTestInfo,
  target: ReadinessTarget,
  navigate: () => Promise<unknown>,
): Promise<void> {
  await withMessageScrollerReadinessEvidence(page, testInfo, target, async (startRenderObservation) => {
    await navigate();
    await startRenderObservation();
    await expect(page.getByTestId("message-scroller")).toBeVisible({
      timeout: MESSAGE_SCROLLER_READINESS_TIMEOUT_MS,
    });
  });
}
