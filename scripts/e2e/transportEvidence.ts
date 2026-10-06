/** E2E-only, opt-in evidence. Never import this into the application server. */
import { randomUUID } from "node:crypto";
import { errorMonitor } from "node:events";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";

export const SEGMENT_BYTES = 256 * 1024;
export const CLIENT_SLOTS = 16;
export const REQUEST_ID_HEADER = "x-e2e-login-request-id";
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const REQUEST_ID = /^e2e-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const TRACEPARENT = /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);
const OCCUPANCY_DETAIL_LIMIT = 32;
const OCCUPANCY_CHECKPOINT_LIMIT = 16;

export type ReadinessRequestKind = "dm-channels" | "channel" | "messages";
export type ReadinessServerStage = "arrival" | "aborted" | "response-finished" | "response-closed";

export type ReadinessServerEvidenceRecord = {
  traceId: string;
  requestKind: ReadinessRequestKind;
  stage: ReadinessServerStage;
  atEpochMs: number;
  status?: number;
  finished?: boolean;
};

export type ReadinessServerEvidence =
  | { state: "matched"; records: ReadinessServerEvidenceRecord[] }
  | { state: "not-observed"; records: [] }
  | { state: "unavailable"; reason: "transport-config-unavailable" | "server-log-unavailable"; records: [] };

let warned = false;
function warnUnavailable() {
  if (warned) return;
  warned = true;
  console.error("[e2e-transport] collection incomplete or unavailable; cause remains undetermined");
}

export type EvidenceConfig = { directory: string; runId: string };
type Fields = {
  apiRequestId?: number;
  requestId?: string | null;
  connectionId?: number;
  retry?: number;
  workerIndex?: number;
  parallelIndex?: number;
  status?: number;
  code?: string;
  hadError?: boolean;
  finished?: boolean;
  exitCode?: number;
  traceId?: string;
  requestKind?: ReadinessRequestKind;
  activeRequests?: Array<{
    apiRequestId: number;
    connectionId?: number;
    beganAtEpochMs: number;
  }>;
  activeTruncated?: number;
};

export type ApiRequestOccupancyProbe = {
  traceId: string;
  clientStartedAtEpochMs: number;
  assertionEndedAtEpochMs: number;
};

type ApiRequestOccupancyActive = {
  serverInstanceId: string;
  apiRequestId: number;
  connectionId?: number;
  beganBeforeClientStartMs: number;
};

type ApiRequestOccupancyRelease = {
  serverInstanceId: string;
  apiRequestId: number;
  connectionId?: number;
  stage: "response-finished" | "failed" | "teardown" | "connection-closed" | "process-exited";
  afterClientStartMs: number;
};

export type ApiRequestOccupancySnapshot = {
  traceId: string;
  clientStartedAtEpochMs: number;
  atClientStart: {
    state: "known" | "unknown";
    unknownReasons: Array<"partial-retention" | "missing-connection-correlation">;
    observedActiveRequestCount: number;
    observedActiveConnectionCount: number;
    active: ApiRequestOccupancyActive[];
    activeTruncated: number;
  };
  targetServerRequest:
    | { state: "arrived"; serverInstanceId: string; apiRequestId: number; connectionId?: number; afterClientStartMs: number }
    | { state: "not-observed" };
  releasesBeforeAssertionEnd: ApiRequestOccupancyRelease[];
  releasesTruncated: number;
};

export type ApiRequestOccupancyEvidence =
  | {
      state: "matched";
      coverage: "complete-from-process-start" | "complete-from-checkpoint" | "partial-retention";
      snapshots: ApiRequestOccupancySnapshot[];
    }
  | { state: "not-observed"; snapshots: [] }
  | {
      state: "unavailable";
      reason: "transport-config-unavailable" | "server-api-log-unavailable";
      snapshots: [];
    };

export function traceIdFromTraceparent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().toLowerCase().match(TRACEPARENT);
  if (!match || match[1] === ZERO_TRACE_ID || match[2] === ZERO_SPAN_ID) return null;
  return match[1]!;
}

function classifyReadinessRequest(method: string | undefined, rawUrl: string | undefined): ReadinessRequestKind | null {
  if (method !== "GET" || !rawUrl) return null;
  let pathname: string;
  try {
    pathname = new URL(rawUrl, "http://e2e.invalid").pathname;
  } catch {
    return null;
  }
  if (pathname === "/api/channels/dm") return "dm-channels";
  if (/^\/api\/channels\/[^/]+$/.test(pathname)) return "channel";
  if (/^\/api\/messages\/channel\/[^/]+$/.test(pathname)) return "messages";
  return null;
}

function isApiRequest(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const pathname = new URL(rawUrl, "http://e2e.invalid").pathname;
    return pathname === "/api" || pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

/** Explicit allowlist; exception messages can contain headers/passwords. */
function errorCode(error: unknown): string {
  try {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" && ["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNREFUSED", "EADDRINUSE"].includes(code)
      ? code : "unknown";
  } catch {
    return "unknown";
  }
}

export function evidenceConfig(env = process.env): EvidenceConfig | undefined {
  const directory = env.SLOCK_E2E_TRANSPORT_DIR;
  const runId = env.SLOCK_E2E_TRANSPORT_RUN_ID;
  return directory && path.isAbsolute(directory) && runId && UUID.test(runId) ? { directory, runId } : undefined;
}

/** One invocation only. The runner supplies a fixed dedicated artifact subdirectory. */
export function prepareTransportEvidence(directory: string): EvidenceConfig | undefined {
  try {
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    return { directory, runId: randomUUID() };
  } catch {
    warnUnavailable();
    return undefined;
  }
}

/** Single writer per slot: Playwright replaces a failed worker before reusing its parallelIndex. */
export function createEvidenceWriter(
  config: EvidenceConfig,
  slot: string,
  options: { beforeRotate?: () => { event: string; fields?: Fields } | undefined } = {},
) {
  const instanceId = randomUUID();
  const file = path.join(config.directory, `${slot}.jsonl`);
  let sequence = 0;
  let disabled = false;
  return (event: string, fields: Fields = {}) => {
    if (disabled) return false;
    try {
      // Only projected diagnostic fields reach disk, never arbitrary error or HTTP objects.
      const encode = (nextSequence: number, nextEvent: string, nextFields: Fields, time: string) => JSON.stringify({
        version: 1, runId: config.runId, instanceId, pid: process.pid,
        sequence: nextSequence, time, event: nextEvent,
        ...nextFields,
      }) + "\n";
      const time = new Date().toISOString();
      let line = encode(sequence + 1, event, fields, time);
      if (Buffer.byteLength(line) > 2048) {
        sequence++;
        return false;
      }
      const size = existsSync(file) ? statSync(file).size : 0;
      if (size + Buffer.byteLength(line) > SEGMENT_BYTES) {
        rmSync(`${file}.1`, { force: true });
        renameSync(file, `${file}.1`);
        const checkpoint = options.beforeRotate?.();
        if (checkpoint) {
          const checkpointLine = encode(sequence + 1, checkpoint.event, checkpoint.fields ?? {}, time);
          sequence++;
          if (Buffer.byteLength(checkpointLine) <= 2048) appendFileSync(file, checkpointLine, { mode: 0o600 });
        }
        line = encode(sequence + 1, event, fields, time);
      }
      sequence++;
      appendFileSync(file, line, { mode: 0o600 });
      return true;
    } catch {
      disabled = true;
      warnUnavailable();
      return false;
    }
  };
}

/** No signal handlers or uncaughtException handler: retain Node's exit semantics. */
export function observeApiProcess(config: EvidenceConfig | undefined) {
  if (!config) return undefined;
  const emit = createEvidenceWriter(config, "server");
  const activeApiRequests = new Map<number, {
    apiRequestId: number;
    connectionId?: number;
    beganAtEpochMs: number;
  }>();
  const apiEmit = createEvidenceWriter(config, "server-api", {
    beforeRotate: () => {
      const activeRequests = [...activeApiRequests.values()]
        .sort((a, b) => a.apiRequestId - b.apiRequestId);
      return {
        event: "api_occupancy_checkpoint",
        fields: {
          activeRequests: activeRequests.slice(0, OCCUPANCY_CHECKPOINT_LIMIT),
          activeTruncated: Math.max(0, activeRequests.length - OCCUPANCY_CHECKPOINT_LIMIT),
        },
      };
    },
  });
  let nextConnectionId = 0;
  let nextApiRequestId = 0;
  emit("process_start");
  apiEmit("process_start");
  process.on("exit", (exitCode) => {
    emit("process_exit", { exitCode });
    apiEmit("process_exit", { exitCode });
    activeApiRequests.clear();
  });
  process.on("uncaughtExceptionMonitor", (error) => { emit("process_uncaught", { code: errorCode(error) }); });
  return (server: Server) => {
    const ids = new WeakMap<object, number>();
    server.on("listening", () => { emit("listener_listening"); });
    server.on("close", () => { emit("listener_close"); });
    // errorMonitor observes without swallowing an otherwise fatal unhandled 'error'.
    server.on(errorMonitor, (error) => { emit("listener_error", { code: errorCode(error) }); });
    server.on("connection", (socket) => {
      const connectionId = ++nextConnectionId;
      ids.set(socket, connectionId);
      emit("connection_open", { connectionId });
      apiEmit("connection_open", { connectionId });
      socket.on(errorMonitor, (error) => { emit("connection_error", { connectionId, code: errorCode(error) }); });
      socket.on("close", (hadError) => {
        emit("connection_close", { connectionId, hadError });
        apiEmit("connection_close", { connectionId, hadError });
        for (const [apiRequestId, active] of activeApiRequests) {
          if (active.connectionId === connectionId) activeApiRequests.delete(apiRequestId);
        }
      });
    });
    server.prependListener("request", (request, response) => {
      if (isApiRequest(request.url)) {
        const apiRequestId = ++nextApiRequestId;
        const connectionId = ids.get(request.socket);
        const traceId = traceIdFromTraceparent(request.headers.traceparent);
        const fields = {
          apiRequestId,
          ...(connectionId !== undefined ? { connectionId } : {}),
          ...(traceId ? { traceId } : {}),
        };
        let failed = false;
        const emitFailed = (code?: string) => {
          if (failed) return;
          failed = true;
          apiEmit("api_request_failed", { ...fields, ...(code ? { code } : {}) });
          activeApiRequests.delete(apiRequestId);
        };
        const beganAtEpochMs = Date.now();
        if (apiEmit("api_request_begin", fields)) {
          activeApiRequests.set(apiRequestId, {
            apiRequestId,
            ...(connectionId !== undefined ? { connectionId } : {}),
            beganAtEpochMs,
          });
        }
        request.on("aborted", () => { emitFailed("ECONNRESET"); });
        response.on(errorMonitor, (error) => { emitFailed(errorCode(error)); });
        response.on("finish", () => {
          apiEmit("api_request_finish", { ...fields, status: response.statusCode });
          activeApiRequests.delete(apiRequestId);
        });
        response.on("close", () => {
          if (!response.writableFinished) emitFailed();
          apiEmit("api_request_teardown", { ...fields, finished: response.writableFinished });
        });
      }

      if (request.method === "POST" && request.url === "/api/auth/login") {
        const candidate = request.headers[REQUEST_ID_HEADER];
        const requestId = typeof candidate === "string" && REQUEST_ID.test(candidate) ? candidate : null;
        const fields = { requestId, connectionId: ids.get(request.socket) };
        emit("login_arrival", fields);
        request.on("aborted", () => { emit("login_aborted", fields); });
        response.on("finish", () => { emit("login_finish", { ...fields, status: response.statusCode }); });
        response.on("close", () => { emit("login_close", { ...fields, finished: response.writableFinished }); });
      }

      const requestKind = classifyReadinessRequest(request.method, request.url);
      const traceId = traceIdFromTraceparent(request.headers.traceparent);
      if (!requestKind || !traceId) return;
      const fields = { traceId, requestKind, connectionId: ids.get(request.socket) };
      emit("readiness_request_arrival", fields);
      request.on("aborted", () => { emit("readiness_request_aborted", fields); });
      response.on("finish", () => {
        emit("readiness_request_finish", { ...fields, status: response.statusCode });
      });
      response.on("close", () => {
        if (!response.writableFinished) {
          emit("readiness_request_close", { ...fields, finished: false });
        }
      });
    });
  };
}

type ApiEvidenceRow = {
  event: string;
  atEpochMs: number;
  sequence: number;
  instanceId: string;
  apiRequestId?: number;
  connectionId?: number;
  traceId?: string;
  checkpointActiveRequests?: Array<{
    apiRequestId: number;
    connectionId?: number;
    beganAtEpochMs: number;
  }>;
  checkpointActiveTruncated?: number;
};

const API_TERMINAL_STAGES = {
  api_request_finish: "response-finished",
  api_request_failed: "failed",
  api_request_teardown: "teardown",
} as const;

function apiRequestKey(row: Pick<ApiEvidenceRow, "instanceId" | "apiRequestId">): string | undefined {
  return row.apiRequestId === undefined ? undefined : `${row.instanceId}:${row.apiRequestId}`;
}

function lastIndexMatching<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}

function parseCheckpointActiveRequests(value: unknown): ApiEvidenceRow["checkpointActiveRequests"] {
  if (!Array.isArray(value) || value.length > OCCUPANCY_CHECKPOINT_LIMIT) return undefined;
  const parsed: NonNullable<ApiEvidenceRow["checkpointActiveRequests"]> = [];
  for (const request of value) {
    if (
      typeof request !== "object"
      || request === null
      || typeof (request as Record<string, unknown>).apiRequestId !== "number"
      || !Number.isInteger((request as Record<string, unknown>).apiRequestId)
      || typeof (request as Record<string, unknown>).beganAtEpochMs !== "number"
      || !Number.isFinite((request as Record<string, unknown>).beganAtEpochMs)
    ) return undefined;
    const connectionId = (request as Record<string, unknown>).connectionId;
    if (connectionId !== undefined && (typeof connectionId !== "number" || !Number.isInteger(connectionId))) return undefined;
    parsed.push({
      apiRequestId: (request as Record<string, unknown>).apiRequestId as number,
      ...(typeof connectionId === "number" ? { connectionId } : {}),
      beganAtEpochMs: (request as Record<string, unknown>).beganAtEpochMs as number,
    });
  }
  return parsed;
}

function readApiEvidenceRows(config: EvidenceConfig): { readable: boolean; rows: ApiEvidenceRow[] } {
  let readable = false;
  const rows: ApiEvidenceRow[] = [];
  for (const suffix of [".1", ""]) {
    const file = path.join(config.directory, `server-api.jsonl${suffix}`);
    if (!existsSync(file)) continue;
    let body: string;
    try {
      body = readFileSync(file, "utf8");
      readable = true;
    } catch {
      continue;
    }
    for (const line of body.split("\n")) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        const atEpochMs = typeof row.time === "string" ? Date.parse(row.time) : Number.NaN;
        if (
          row.runId !== config.runId
          || typeof row.event !== "string"
          || typeof row.sequence !== "number"
          || typeof row.instanceId !== "string"
          || !Number.isFinite(atEpochMs)
        ) continue;
        rows.push({
          event: row.event,
          atEpochMs,
          sequence: row.sequence,
          instanceId: row.instanceId,
          ...(typeof row.apiRequestId === "number" ? { apiRequestId: row.apiRequestId } : {}),
          ...(typeof row.connectionId === "number" ? { connectionId: row.connectionId } : {}),
          ...(typeof row.traceId === "string" && /^[a-f0-9]{32}$/.test(row.traceId) ? { traceId: row.traceId } : {}),
          ...(row.event === "api_occupancy_checkpoint"
            ? {
                checkpointActiveRequests: parseCheckpointActiveRequests(row.activeRequests),
                ...(typeof row.activeTruncated === "number" && Number.isInteger(row.activeTruncated) && row.activeTruncated >= 0
                  ? { checkpointActiveTruncated: row.activeTruncated }
                  : {}),
              }
            : {}),
        });
      } catch {
        // A partial/rotating JSONL line is unavailable evidence, never a cause.
      }
    }
  }
  rows.sort((a, b) => a.atEpochMs - b.atEpochMs || a.sequence - b.sequence);
  return { readable, rows };
}

/**
 * Summarize anonymous Node-side API occupancy at exact browser request-start
 * instants. Raw URLs, methods, headers, bodies, and errors are never retained.
 */
export function readApiRequestOccupancyEvidence(
  config: EvidenceConfig | undefined,
  probes: readonly ApiRequestOccupancyProbe[],
): ApiRequestOccupancyEvidence {
  if (!config) return { state: "unavailable", reason: "transport-config-unavailable", snapshots: [] };
  const validProbes = probes.filter((probe) => (
    /^[a-f0-9]{32}$/.test(probe.traceId)
    && probe.traceId !== ZERO_TRACE_ID
    && Number.isFinite(probe.clientStartedAtEpochMs)
    && Number.isFinite(probe.assertionEndedAtEpochMs)
    && probe.assertionEndedAtEpochMs >= probe.clientStartedAtEpochMs
  ));
  const evidence = readApiEvidenceRows(config);
  if (!evidence.readable) return { state: "unavailable", reason: "server-api-log-unavailable", snapshots: [] };
  const apiRows = evidence.rows.filter((row) => (
    row.event === "api_request_begin"
    || row.event in API_TERMINAL_STAGES
    || row.event === "connection_close"
    || row.event === "process_exit"
  ));
  if (apiRows.length === 0 || validProbes.length === 0) return { state: "not-observed", snapshots: [] };

  const rowsByInstance = new Map<string, ApiEvidenceRow[]>();
  for (const row of evidence.rows) {
    const rows = rowsByInstance.get(row.instanceId) ?? [];
    rows.push(row);
    rowsByInstance.set(row.instanceId, rows);
  }
  for (const rows of rowsByInstance.values()) rows.sort((a, b) => a.sequence - b.sequence || a.atEpochMs - b.atEpochMs);

  const reconstructions = validProbes.map((probe) => {
    const active = new Map<string, {
      serverInstanceId: string;
      apiRequestId: number;
      connectionId?: number;
      beganAtEpochMs: number;
    }>();
    let complete = rowsByInstance.size > 0;
    let usedCheckpoint = false;
    for (const [instanceId, allRows] of rowsByInstance) {
      const lastRelevantIndex = lastIndexMatching(allRows, (row) => row.atEpochMs <= probe.clientStartedAtEpochMs);
      if (lastRelevantIndex < 0) {
        // A later checkpoint can contain requests that began before this probe,
        // but cannot reveal requests that also ended before the checkpoint.
        complete = false;
        continue;
      }
      const relevantRows = allRows.slice(0, lastRelevantIndex + 1);
      // Include the first retained row after the probe as a continuity sentinel:
      // a sequence gap there may hide a close/terminal immediately before the
      // probe even though the retained timestamp is later.
      const continuityEndIndex = Math.min(lastRelevantIndex + 1, allRows.length - 1);
      const continuityRows = allRows.slice(0, continuityEndIndex + 1);
      const processStartComplete = continuityRows[0]?.event === "process_start"
        && continuityRows[0].sequence === 1
        && continuityRows.every((row, index) => index === 0 || row.sequence === continuityRows[index - 1]!.sequence + 1);
      let startIndex = 0;
      if (!processStartComplete) {
        const checkpointIndex = lastIndexMatching(relevantRows, (row) => (
          row.event === "api_occupancy_checkpoint"
          && row.checkpointActiveRequests !== undefined
          && row.checkpointActiveTruncated === 0
        ));
        const checkpointTailComplete = checkpointIndex >= 0
          && continuityRows.slice(checkpointIndex).every((row, index, tail) => (
            index === 0 || row.sequence === tail[index - 1]!.sequence + 1
          ));
        if (checkpointIndex >= 0 && checkpointTailComplete) {
          const checkpoint = relevantRows[checkpointIndex]!;
          for (const request of checkpoint.checkpointActiveRequests!) {
            active.set(`${instanceId}:${request.apiRequestId}`, {
              serverInstanceId: instanceId,
              apiRequestId: request.apiRequestId,
              ...(request.connectionId !== undefined ? { connectionId: request.connectionId } : {}),
              beganAtEpochMs: request.beganAtEpochMs,
            });
          }
          startIndex = checkpointIndex + 1;
          usedCheckpoint = true;
        } else {
          complete = false;
        }
      }
      for (const row of relevantRows.slice(startIndex)) {
        const requestKey = apiRequestKey(row);
        if (row.event === "api_request_begin" && requestKey && row.apiRequestId !== undefined) {
          active.set(requestKey, {
            serverInstanceId: row.instanceId,
            apiRequestId: row.apiRequestId,
            ...(row.connectionId !== undefined ? { connectionId: row.connectionId } : {}),
            beganAtEpochMs: row.atEpochMs,
          });
        } else if (requestKey && row.event in API_TERMINAL_STAGES) {
          active.delete(requestKey);
        } else if (row.event === "connection_close" && row.connectionId !== undefined) {
          for (const [key, request] of active) {
            if (request.serverInstanceId === row.instanceId && request.connectionId === row.connectionId) active.delete(key);
          }
        } else if (row.event === "process_exit") {
          for (const [key, request] of active) {
            if (request.serverInstanceId === row.instanceId) active.delete(key);
          }
        }
      }
    }
    return { active, complete, usedCheckpoint };
  });
  const coverage: "complete-from-process-start" | "complete-from-checkpoint" | "partial-retention" = reconstructions.every((reconstruction) => reconstruction.complete)
    ? reconstructions.some((reconstruction) => reconstruction.usedCheckpoint)
      ? "complete-from-checkpoint"
      : "complete-from-process-start"
    : "partial-retention";

  const snapshots = validProbes.map((probe, probeIndex): ApiRequestOccupancySnapshot => {
    const reconstruction = reconstructions[probeIndex]!;
    const active = reconstruction.active;

    const allActiveAtStart = [...active.values()]
      .sort((a, b) => a.serverInstanceId.localeCompare(b.serverInstanceId) || a.apiRequestId - b.apiRequestId)
      .map((request) => ({
        serverInstanceId: request.serverInstanceId,
        apiRequestId: request.apiRequestId,
        ...(request.connectionId !== undefined ? { connectionId: request.connectionId } : {}),
        beganBeforeClientStartMs: Math.max(0, probe.clientStartedAtEpochMs - request.beganAtEpochMs),
      }));
    const activeAtStart = allActiveAtStart.slice(0, OCCUPANCY_DETAIL_LIMIT);
    const activeByRequestKey = new Map(allActiveAtStart.map((request) => [
      `${request.serverInstanceId}:${request.apiRequestId}`,
      request,
    ]));
    const released = new Set<string>();
    const releasesBeforeAssertionEnd: ApiRequestOccupancyRelease[] = [];
    for (const row of apiRows) {
      if (row.atEpochMs < probe.clientStartedAtEpochMs || row.atEpochMs > probe.assertionEndedAtEpochMs) continue;
      const requestKey = apiRequestKey(row);
      const terminalStage = API_TERMINAL_STAGES[row.event as keyof typeof API_TERMINAL_STAGES];
      const candidates = terminalStage && requestKey
        ? [requestKey]
        : row.event === "connection_close" && row.connectionId !== undefined
          ? [...activeByRequestKey.entries()]
              .filter(([, request]) => request.serverInstanceId === row.instanceId && request.connectionId === row.connectionId)
              .map(([key]) => key)
          : row.event === "process_exit"
            ? [...activeByRequestKey.entries()]
                .filter(([, request]) => request.serverInstanceId === row.instanceId)
                .map(([key]) => key)
            : [];
      const stage = terminalStage
        ?? (row.event === "connection_close" ? "connection-closed" : row.event === "process_exit" ? "process-exited" : undefined);
      if (!stage) continue;
      for (const key of candidates) {
        const request = activeByRequestKey.get(key);
        if (!request || released.has(key)) continue;
        released.add(key);
        if (releasesBeforeAssertionEnd.length < OCCUPANCY_DETAIL_LIMIT) {
          releasesBeforeAssertionEnd.push({
            serverInstanceId: request.serverInstanceId,
            apiRequestId: request.apiRequestId,
            ...(request.connectionId !== undefined ? { connectionId: request.connectionId } : {}),
            stage,
            afterClientStartMs: Math.max(0, row.atEpochMs - probe.clientStartedAtEpochMs),
          });
        }
      }
    }

    const targetArrival = apiRows.find((row) => (
      row.event === "api_request_begin"
      && row.traceId === probe.traceId
      && row.apiRequestId !== undefined
      && row.connectionId !== undefined
    ));
    return {
      traceId: probe.traceId,
      clientStartedAtEpochMs: probe.clientStartedAtEpochMs,
      atClientStart: {
        state: reconstruction.complete && allActiveAtStart.every((request) => request.connectionId !== undefined)
          ? "known"
          : "unknown",
        unknownReasons: [
          ...(!reconstruction.complete ? ["partial-retention" as const] : []),
          ...(allActiveAtStart.some((request) => request.connectionId === undefined)
            ? ["missing-connection-correlation" as const]
            : []),
        ],
        observedActiveRequestCount: allActiveAtStart.length,
        observedActiveConnectionCount: new Set(allActiveAtStart.flatMap((request) => (
          request.connectionId === undefined ? [] : [`${request.serverInstanceId}:${request.connectionId}`]
        ))).size,
        active: activeAtStart,
        activeTruncated: allActiveAtStart.length - activeAtStart.length,
      },
      targetServerRequest: targetArrival
        ? {
            state: "arrived",
            serverInstanceId: targetArrival.instanceId,
            apiRequestId: targetArrival.apiRequestId!,
            ...(targetArrival.connectionId !== undefined ? { connectionId: targetArrival.connectionId } : {}),
            afterClientStartMs: Math.max(0, targetArrival.atEpochMs - probe.clientStartedAtEpochMs),
          }
        : { state: "not-observed" },
      releasesBeforeAssertionEnd,
      releasesTruncated: released.size - releasesBeforeAssertionEnd.length,
    };
  });
  return { state: "matched", coverage, snapshots };
}

const READINESS_SERVER_EVENTS = {
  readiness_request_arrival: "arrival",
  readiness_request_aborted: "aborted",
  readiness_request_finish: "response-finished",
  readiness_request_close: "response-closed",
} as const satisfies Record<string, ReadinessServerStage>;

/**
 * Read only the bounded E2E transport segments and project records for the
 * supplied opaque trace ids. This is called only after a readiness failure so
 * the failure attachment retains its own correlation even if later shard
 * traffic rotates the shared transport log.
 */
export function readReadinessServerEvidence(
  config: EvidenceConfig | undefined,
  traceIds: readonly string[],
): ReadinessServerEvidence {
  if (!config) return { state: "unavailable", reason: "transport-config-unavailable", records: [] };
  const wanted = new Set(traceIds.filter((traceId) => /^[a-f0-9]{32}$/.test(traceId) && traceId !== ZERO_TRACE_ID));
  if (wanted.size === 0) return { state: "not-observed", records: [] };

  let readable = false;
  const records: ReadinessServerEvidenceRecord[] = [];
  for (const suffix of [".1", ""]) {
    const file = path.join(config.directory, `server.jsonl${suffix}`);
    if (!existsSync(file)) continue;
    let body: string;
    try {
      body = readFileSync(file, "utf8");
      readable = true;
    } catch {
      continue;
    }
    for (const line of body.split("\n")) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        if (row.runId !== config.runId || typeof row.event !== "string") continue;
        const stage = READINESS_SERVER_EVENTS[row.event as keyof typeof READINESS_SERVER_EVENTS];
        const traceId = typeof row.traceId === "string" ? row.traceId : "";
        const requestKind = row.requestKind;
        const atEpochMs = typeof row.time === "string" ? Date.parse(row.time) : Number.NaN;
        if (
          !stage
          || !wanted.has(traceId)
          || !["dm-channels", "channel", "messages"].includes(String(requestKind))
          || !Number.isFinite(atEpochMs)
        ) continue;
        records.push({
          traceId,
          requestKind: requestKind as ReadinessRequestKind,
          stage,
          atEpochMs,
          ...(typeof row.status === "number" ? { status: row.status } : {}),
          ...(typeof row.finished === "boolean" ? { finished: row.finished } : {}),
        });
      } catch {
        // A partial/rotating JSONL line is unavailable evidence, never a cause.
      }
    }
  }
  if (!readable) return { state: "unavailable", reason: "server-log-unavailable", records: [] };
  if (records.length === 0) return { state: "not-observed", records: [] };
  records.sort((a, b) => a.atEpochMs - b.atEpochMs);
  return { state: "matched", records };
}

export type LoginAttempt = { retry: number; workerIndex: number; parallelIndex: number };

/** Pin only the first failing login in each slot; later chatter cannot overwrite it. */
function pinFirstFailure(config: EvidenceConfig, slot: string, fields: Fields, clientRecorded: boolean) {
  const marker = path.join(config.directory, `first-failure-${slot}.json`);
  try {
    if (existsSync(marker)) return;
    const copied: string[] = [];
    for (const suffix of ["", ".1"]) {
      const source = path.join(config.directory, `server.jsonl${suffix}`);
      if (existsSync(source) && statSync(source).size <= SEGMENT_BYTES) {
        const name = `first-failure-${slot}-server.jsonl${suffix}`;
        copyFileSync(source, path.join(config.directory, name));
        copied.push(name);
      }
    }
    writeFileSync(marker, JSON.stringify({
      runId: config.runId, ...fields, time: new Date().toISOString(), clientRecorded,
      serverSnapshots: copied, interpretation: "partial evidence; missing events do not establish a cause",
    }) + "\n", { flag: "wx", mode: 0o600 });
  } catch {
    warnUnavailable();
  }
}

/** Wrap exactly one existing login, preserving the result or the original thrown object. */
export async function observeLogin<T>(
  config: EvidenceConfig | undefined,
  attempt: LoginAttempt | undefined,
  login: (headers: Record<string, string> | undefined) => Promise<T>,
): Promise<T> {
  if (!config || (attempt && (!Number.isInteger(attempt.parallelIndex) || attempt.parallelIndex < 0 || attempt.parallelIndex >= CLIENT_SLOTS))) {
    return login(undefined);
  }
  const slot = attempt ? `client-${attempt.parallelIndex}` : "client-setup";
  const emit = createEvidenceWriter(config, slot);
  const requestId = `e2e-${randomUUID()}`;
  const fields = { requestId, ...attempt };
  emit("login_begin", fields);
  try {
    const result = await login({ [REQUEST_ID_HEADER]: requestId });
    emit("login_success", fields);
    return result;
  } catch (error) {
    const recorded = emit("login_failure", { ...fields, code: errorCode(error) });
    pinFirstFailure(config, slot, { ...fields, code: errorCode(error) }, recorded);
    throw error;
  }
}
