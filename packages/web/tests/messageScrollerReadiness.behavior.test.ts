import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import {
  classifyMessageScrollerRequest,
  MESSAGE_SCROLLER_READINESS_TIMEOUT_MS,
  withMessageScrollerReadinessEvidence,
} from "./e2e/fixtures/messageScrollerReadiness";

type Listener = (value: unknown) => void;

class FakePage {
  readonly handlers = new Map<string, Set<Listener>>();
  disposed = false;
  probeUnavailable = false;
  executeProbeExpression = false;
  messageSurfaceText = "Loading…";
  surroundingColumnText = "";
  probeClockAdvanceMs = 50;

  async evaluateHandle(expression: unknown) {
    if (this.probeUnavailable) throw new Error("probe unavailable");
    assert.equal(typeof expression, "string");
    new vm.Script(expression);
    if (this.executeProbeExpression) {
      const receiptStartMatch = expression.match(/const receiptStartedAtEpochMs = (\d+);/);
      assert.ok(receiptStartMatch, "probe must bind the shared receipt-start epoch");
      const receiptStartedAtEpochMs = Number(receiptStartMatch[1]);
      const messageSurface = {
        innerText: this.messageSurfaceText,
        querySelectorAll: (selector: string) => selector === '[data-testid="message-scroller"]' ? [] : [],
      };
      const targetSurface = {
        innerText: `${this.surroundingColumnText}\n${this.messageSurfaceText}`,
        querySelector: (selector: string) => (
          selector === '[data-testid="message-content-surface"]' ? messageSurface : null
        ),
      };
      const probe = vm.runInNewContext(expression, {
        Date: { now: () => receiptStartedAtEpochMs + this.probeClockAdvanceMs },
        decodeURIComponent,
        document: {
          body: { innerText: this.surroundingColumnText },
          documentElement: {},
          querySelector: (selector: string) => (
            selector === '[data-testid="thread-main-column"]' ? targetSurface : null
          ),
        },
        location: { pathname: "/s/server/channel/target-channel" },
        MutationObserver: class {
          observe() {}
          disconnect() {}
        },
        performance: { now: () => 0 },
      }) as { stopAndRead: () => unknown };
      return {
        evaluate: async (read: (value: typeof probe) => unknown) => read(probe),
        dispose: async () => {
          this.disposed = true;
        },
      };
    }
    return {
      evaluate: async () => ({
        samples: [{ atMs: 0, stage: "message-loading", scrollerCount: 0 }],
        final: {
          atMs: 5000,
          stage: "message-loading",
          scrollerCount: 0,
          routeKind: "channel",
          routeChannelId: "target-channel",
          routeMatchesTarget: true,
        },
      }),
      dispose: async () => {
        this.disposed = true;
      },
    };
  }

  on(name: string, listener: Listener) {
    const listeners = this.handlers.get(name) ?? new Set<Listener>();
    listeners.add(listener);
    this.handlers.set(name, listeners);
  }

  off(name: string, listener: Listener) {
    this.handlers.get(name)?.delete(listener);
  }

  emit(name: string, value: unknown) {
    for (const listener of this.handlers.get(name) ?? []) listener(value);
  }

  get listenerCount() {
    let count = 0;
    for (const listeners of this.handlers.values()) count += listeners.size;
    return count;
  }
}

function fakeRequest(rawUrl: string, failureText?: string, traceparent?: string) {
  return {
    method: () => "GET",
    url: () => rawUrl,
    headers: () => traceparent ? { traceparent } : {},
    failure: () => failureText ? { errorText: failureText } : null,
  };
}

function fakeResponse(request: ReturnType<typeof fakeRequest>, status: number) {
  return { request: () => request, status: () => status };
}

test("request matcher accepts only exact target channel GETs and ignores queries", () => {
  assert.equal(
    classifyMessageScrollerRequest("GET", "http://localhost/api/channels/dm?secret=hidden", "target"),
    "dm-channels",
  );
  assert.equal(
    classifyMessageScrollerRequest("GET", "http://localhost/api/channels/target?secret=hidden", "target"),
    "channel",
  );
  assert.equal(
    classifyMessageScrollerRequest("GET", "http://localhost/api/messages/channel/target?limit=50", "target"),
    "messages",
  );
  assert.equal(
    classifyMessageScrollerRequest("GET", "http://localhost/api/messages/channel/other?limit=50", "target"),
    null,
  );
  assert.equal(
    classifyMessageScrollerRequest("POST", "http://localhost/api/channels/target", "target"),
    null,
  );
});

test("successful readiness keeps the five-second contract and emits no attachment", async () => {
  const page = new FakePage();
  let attachments = 0;

  const result = await withMessageScrollerReadinessEvidence(
    page as never,
    { retry: 0, attach: async () => { attachments += 1; } } as never,
    { consumer: "unread-click-read", channelId: "target-channel" },
    async (startRenderObservation) => {
      await startRenderObservation();
      return "ready";
    },
  );

  assert.equal(MESSAGE_SCROLLER_READINESS_TIMEOUT_MS, 5_000);
  assert.equal(result, "ready");
  assert.equal(attachments, 0);
  assert.equal(page.disposed, true);
  assert.equal(page.listenerCount, 0);
});

test("failed readiness attaches a bounded sanitized lifecycle receipt and rethrows the same error", async () => {
  const page = new FakePage();
  const original = new Error("original visibility assertion");
  const targetRequest = fakeRequest("http://localhost/api/messages/channel/target-channel?secret=do-not-record");
  const unrelatedRequest = fakeRequest("http://localhost/api/messages/channel/other-channel?secret=also-hidden");
  const overflowRequests = Array.from({ length: 9 }, (_, index) =>
    fakeRequest(`http://localhost/api/channels/target-channel?secret=overflow-${index}`)
  );
  let attachmentName = "";
  let receipt: Record<string, unknown> | null = null;

  const caught = await withMessageScrollerReadinessEvidence(
    page as never,
    {
      retry: 0,
      attach: async (name: string, attachment: { body: Buffer }) => {
        attachmentName = name;
        receipt = JSON.parse(attachment.body.toString("utf8"));
      },
    } as never,
    { consumer: "channel-task-board", channelId: "target-channel" },
    async (startRenderObservation) => {
      page.emit("request", unrelatedRequest);
      page.emit("request", targetRequest);
      page.emit("response", fakeResponse(targetRequest, 200));
      page.emit("requestfinished", targetRequest);
      for (const request of overflowRequests) page.emit("request", request);
      await startRenderObservation();
      throw original;
    },
  ).catch(error => error);

  assert.equal(caught, original);
  assert.equal(attachmentName, "message-scroller-readiness-channel-task-board.json");
  assert.equal(page.listenerCount, 0);
  assert.equal(receipt?.consumer, "channel-task-board");
  assert.equal((receipt?.requests as unknown[]).length, 8);
  assert.deepEqual((receipt?.requests as unknown[])[0], {
    id: 1,
    kind: "messages",
    startedAtMs: (receipt?.requests as Array<{ startedAtMs: number }>)[0].startedAtMs,
    traceCorrelationState: "unavailable",
    responseAtMs: (receipt?.requests as Array<{ responseAtMs: number }>)[0].responseAtMs,
    status: 200,
    finishedAtMs: (receipt?.requests as Array<{ finishedAtMs: number }>)[0].finishedAtMs,
  });
  assert.deepEqual(receipt?.unavailable, ["message-store-state", "receiver-ingress-generation"]);
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("do-not-record"), false);
  assert.equal(serialized.includes("other-channel"), false);
  assert.equal(serialized.includes("http://"), false);
});

test("failed readiness retains the opaque browser/server request correlation in its own attachment", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "readiness-correlation-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const runId = "11111111-1111-4111-8111-111111111111";
  const traceId = "a".repeat(32);
  const traceparent = `00-${traceId}-${"b".repeat(16)}-01`;
  const oldDirectory = process.env.SLOCK_E2E_TRANSPORT_DIR;
  const oldRunId = process.env.SLOCK_E2E_TRANSPORT_RUN_ID;
  process.env.SLOCK_E2E_TRANSPORT_DIR = directory;
  process.env.SLOCK_E2E_TRANSPORT_RUN_ID = runId;
  onTestFinished(() => {
    if (oldDirectory === undefined) delete process.env.SLOCK_E2E_TRANSPORT_DIR;
    else process.env.SLOCK_E2E_TRANSPORT_DIR = oldDirectory;
    if (oldRunId === undefined) delete process.env.SLOCK_E2E_TRANSPORT_RUN_ID;
    else process.env.SLOCK_E2E_TRANSPORT_RUN_ID = oldRunId;
  });

  const serverEventTime = new Date().toISOString();
  await writeFile(path.join(directory, "server.jsonl"), [
    { version: 1, runId, time: serverEventTime, event: "readiness_request_arrival", traceId, requestKind: "messages" },
    { version: 1, runId, time: serverEventTime, event: "readiness_request_finish", traceId, requestKind: "messages", status: 200 },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const apiInstanceId = "22222222-2222-4222-8222-222222222222";
  const apiStartedAt = Date.now() - 100;
  await writeFile(path.join(directory, "server-api.jsonl"), [
    { version: 1, runId, instanceId: apiInstanceId, sequence: 1, time: new Date(apiStartedAt - 1).toISOString(), event: "process_start" },
    ...Array.from({ length: 6 }, (_, index) => ({
      version: 1,
      runId,
      instanceId: apiInstanceId,
      sequence: index + 2,
      time: new Date(apiStartedAt + index).toISOString(),
      event: "api_request_begin",
      apiRequestId: index + 1,
      connectionId: index + 1,
    })),
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");

  const page = new FakePage();
  const original = new Error("original visibility assertion");
  const targetRequest = fakeRequest(
    "http://localhost/api/messages/channel/target-channel?secret=do-not-record",
    undefined,
    traceparent,
  );
  let receipt: {
    requests?: Array<{
      id?: number;
      kind?: string;
      startedAtMs?: number;
      traceId?: string;
      traceCorrelationState?: string;
    }>;
    requestEvidence?: { source?: string; interpretation?: string };
    serverEvidence?: {
      state?: string;
      source?: string;
      retention?: string;
      records?: Array<{ traceId?: string; kind?: string; stage?: string; status?: number }>;
    };
    apiOccupancy?: {
      state?: string;
      coverage?: string;
      snapshots?: Array<{
        traceId?: string;
        clientStartedAtMs?: number;
        atClientStart?: {
          state?: string;
          observedActiveRequestCount?: number;
          observedActiveConnectionCount?: number;
        };
        targetServerRequest?: { state?: string };
        releasesBeforeAssertionEnd?: unknown[];
        releasesTruncated?: number;
      }>;
    };
  } | null = null;

  const caught = await withMessageScrollerReadinessEvidence(
    page as never,
    {
      retry: 0,
      attach: async (_name: string, attachment: { body: Buffer }) => {
        receipt = JSON.parse(attachment.body.toString("utf8"));
      },
    } as never,
    { consumer: "unread-click-read", channelId: "target-channel" },
    async () => {
      page.emit("request", targetRequest);
      throw original;
    },
  ).catch(error => error);

  assert.equal(caught, original);
  const browserRequest = receipt?.requests?.[0];
  assert.ok(browserRequest);
  assert.equal(typeof browserRequest.startedAtMs, "number");
  assert.deepEqual(browserRequest, {
    id: 1,
    kind: "messages",
    startedAtMs: browserRequest.startedAtMs,
    traceCorrelationState: "available",
    traceId,
  });
  assert.equal(receipt?.requestEvidence?.source, "playwright-page-request-events");
  assert.match(receipt?.requestEvidence?.interpretation ?? "", /not server arrival/);
  assert.equal(receipt?.serverEvidence?.state, "matched");
  assert.equal(receipt?.serverEvidence?.source, "playwright-node-api-server-http-events");
  assert.equal(receipt?.serverEvidence?.retention, "copied-into-failure-attachment");
  assert.deepEqual(receipt?.serverEvidence?.records?.map((record) => ({
    traceId: record.traceId,
    kind: record.kind,
    stage: record.stage,
    status: record.status,
  })), [
    { traceId, kind: "messages", stage: "arrival", status: undefined },
    { traceId, kind: "messages", stage: "response-finished", status: 200 },
  ]);
  assert.equal(receipt?.apiOccupancy?.state, "matched");
  assert.equal(receipt?.apiOccupancy?.coverage, "complete-from-process-start");
  assert.equal(receipt?.apiOccupancy?.snapshots?.[0]?.traceId, traceId);
  assert.equal(receipt?.apiOccupancy?.snapshots?.[0]?.atClientStart?.state, "known");
  assert.equal(receipt?.apiOccupancy?.snapshots?.[0]?.atClientStart?.observedActiveRequestCount, 6);
  assert.equal(receipt?.apiOccupancy?.snapshots?.[0]?.atClientStart?.observedActiveConnectionCount, 6);
  assert.equal(receipt?.apiOccupancy?.snapshots?.[0]?.targetServerRequest?.state, "not-observed");
  assert.deepEqual(receipt?.apiOccupancy?.snapshots?.[0]?.releasesBeforeAssertionEnd, []);
  assert.equal(receipt?.apiOccupancy?.snapshots?.[0]?.releasesTruncated, 0);
  assert.doesNotMatch(JSON.stringify(receipt), /secret|do-not-record|http:\/\//);
});

test("browser probe scopes loading state to the message content surface and shares the request timeline", async () => {
  const page = new FakePage();
  page.executeProbeExpression = true;
  page.surroundingColumnText = "Loading channel";
  page.messageSurfaceText = "Loading…";
  const original = new Error("original visibility assertion");
  const targetRequest = fakeRequest("http://localhost/api/messages/channel/target-channel");
  let receipt: {
    timeline?: { origin?: string; unit?: string };
    browser?: { final?: { atMs?: number; stage?: string; routeMatchesTarget?: boolean } };
    requests?: Array<{ startedAtMs?: number }>;
  } | null = null;

  const caught = await withMessageScrollerReadinessEvidence(
    page as never,
    {
      retry: 0,
      attach: async (_name: string, attachment: { body: Buffer }) => {
        receipt = JSON.parse(attachment.body.toString("utf8"));
      },
    } as never,
    { consumer: "unread-click-read", channelId: "target-channel" },
    async (startRenderObservation) => {
      page.emit("request", targetRequest);
      await startRenderObservation();
      throw original;
    },
  ).catch(error => error);

  assert.equal(caught, original);
  assert.deepEqual(receipt?.timeline, {
    origin: "receipt-start-before-navigation",
    unit: "ms",
  });
  assert.equal(receipt?.browser?.final?.stage, "message-loading");
  assert.equal(receipt?.browser?.final?.routeMatchesTarget, true);
  assert.equal(receipt?.browser?.final?.atMs, page.probeClockAdvanceMs);
  assert.ok((receipt?.browser?.final?.atMs ?? -1) >= (receipt?.requests?.[0]?.startedAtMs ?? Infinity));
});

test("diagnostic setup and attachment failures never replace the original assertion error", async () => {
  const page = new FakePage();
  page.probeUnavailable = true;
  const original = new Error("original visibility assertion");

  const caught = await withMessageScrollerReadinessEvidence(
    page as never,
    { retry: 0, attach: async () => { throw new Error("attachment unavailable"); } } as never,
    { consumer: "unread-click-read", channelId: "target-channel" },
    async (startRenderObservation) => {
      await startRenderObservation();
      throw original;
    },
  ).catch(error => error);

  assert.equal(caught, original);
  assert.equal(page.listenerCount, 0);
});
