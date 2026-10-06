import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";

export const KIMI_REQUEST_DIAGNOSTIC_AGENT_ID_ENV = "SLOCK_KIMI_REQUEST_DIAGNOSTIC_AGENT_ID";
export const KIMI_REQUEST_DIAGNOSTIC_SESSION_ID_ENV = "SLOCK_KIMI_REQUEST_DIAGNOSTIC_SESSION_ID";

export type KimiRequestDiagnosticOutcome =
  | "success"
  | "http_error"
  | "connection_timeout"
  | "connection_failed"
  | "cancelled"
  | "outer_retrying";

export type KimiRequestDiagnosticRecord = {
  turnId: string;
  step: number;
  outerAttempt: number;
  innerAttempt: number;
  correlationId: string;
  outcome: KimiRequestDiagnosticOutcome;
  durationMs: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  statusCode?: number;
  failedAttempt?: number;
  nextAttempt?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  errorClass?: "timeout" | "connection" | "cancelled";
};

type DiagnosticRequest = {
  method?: unknown;
  path?: unknown;
};

type RequestState = {
  startedAtMs: number;
  turnId: string;
  step: number;
  outerAttempt: number;
  innerAttempt: number;
  correlationId: string;
  statusCode?: number;
  terminal: boolean;
};

type DiagnosticContext = {
  readonly agentId: string;
  readonly sessionId: string;
  readonly env: NodeJS.ProcessEnv;
  readonly emit: (record: KimiRequestDiagnosticRecord) => void;
  readonly now: () => number;
  active: boolean;
  turnId?: string;
  step?: number;
  outerAttempt: number;
  innerAttempt: number;
};

export type KimiRequestDiagnosticSession = {
  run<T>(fn: () => T): T;
  observeSdkEvent(event: unknown): void;
  close(): void;
};

const storage = new AsyncLocalStorage<DiagnosticContext>();
const requests = new WeakMap<object, RequestState>();
let subscribed = false;

function isActive(context: DiagnosticContext): boolean {
  return context.active
    && context.env[KIMI_REQUEST_DIAGNOSTIC_AGENT_ID_ENV]?.trim() === context.agentId
    && context.env[KIMI_REQUEST_DIAGNOSTIC_SESSION_ID_ENV]?.trim() === context.sessionId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requestFromMessage(message: unknown): object | null {
  if (!isRecord(message)) return null;
  const request = message.request;
  return typeof request === "object" && request !== null ? request : null;
}

function isKimiModelRequest(request: object): boolean {
  const candidate = request as DiagnosticRequest;
  if (String(candidate.method ?? "").toUpperCase() !== "POST") return false;
  const requestPath = typeof candidate.path === "string" ? candidate.path.split("?", 1)[0] : "";
  return requestPath.endsWith("/chat/completions");
}

function responseStatusCode(message: unknown): number | undefined {
  if (!isRecord(message) || !isRecord(message.response)) return undefined;
  const statusCode = message.response.statusCode;
  return typeof statusCode === "number" && Number.isInteger(statusCode) ? statusCode : undefined;
}

function errorFromMessage(message: unknown): unknown {
  return isRecord(message) ? message.error : undefined;
}

function errorIdentity(error: unknown): { name: string; code: string } {
  if (!isRecord(error)) return { name: "", code: "" };
  return {
    name: typeof error.name === "string" ? error.name : "",
    code: typeof error.code === "string" ? error.code : "",
  };
}

function classifyError(error: unknown): Pick<KimiRequestDiagnosticRecord, "outcome" | "errorClass"> {
  const { name, code } = errorIdentity(error);
  const identity = `${name} ${code}`.toLowerCase();
  if (identity.includes("abort") || identity.includes("cancel")) {
    return { outcome: "cancelled", errorClass: "cancelled" };
  }
  if (identity.includes("timeout") || identity.includes("timed_out")) {
    return { outcome: "connection_timeout", errorClass: "timeout" };
  }
  return { outcome: "connection_failed", errorClass: "connection" };
}

function emitTerminal(
  context: DiagnosticContext,
  state: RequestState,
  fields: Pick<KimiRequestDiagnosticRecord, "outcome" | "errorClass"> & { statusCode?: number },
): void {
  if (state.terminal || !isActive(context)) return;
  state.terminal = true;
  const finishedAtMs = context.now();
  context.emit({
    turnId: state.turnId,
    step: state.step,
    outerAttempt: state.outerAttempt,
    innerAttempt: state.innerAttempt,
    correlationId: state.correlationId,
    outcome: fields.outcome,
    durationMs: Math.max(0, finishedAtMs - state.startedAtMs),
    startedAtMs: state.startedAtMs,
    finishedAtMs,
    ...(fields.statusCode === undefined ? {} : { statusCode: fields.statusCode }),
    ...(fields.errorClass === undefined ? {} : { errorClass: fields.errorClass }),
  });
}

function subscribeOnce(): void {
  if (subscribed) return;
  subscribed = true;

  channel("undici:request:create").subscribe((message) => {
    const context = storage.getStore();
    const request = requestFromMessage(message);
    if (!context || !isActive(context) || !request || !isKimiModelRequest(request)) return;
    if (context.turnId === undefined || context.step === undefined) return;
    const innerAttempt = ++context.innerAttempt;
    requests.set(request, {
      startedAtMs: context.now(),
      turnId: context.turnId,
      step: context.step,
      outerAttempt: context.outerAttempt,
      innerAttempt,
      correlationId: `${context.sessionId}:${context.turnId}.${context.step}:${context.outerAttempt}.${innerAttempt}`,
      terminal: false,
    });
  });

  channel("undici:request:headers").subscribe((message) => {
    const context = storage.getStore();
    const request = requestFromMessage(message);
    if (!context || !isActive(context) || !request) return;
    const state = requests.get(request);
    if (!state) return;
    const statusCode = responseStatusCode(message);
    state.statusCode = statusCode;
    if (statusCode !== undefined && statusCode >= 400) {
      emitTerminal(context, state, { outcome: "http_error", statusCode });
    }
  });

  channel("undici:request:trailers").subscribe((message) => {
    const context = storage.getStore();
    const request = requestFromMessage(message);
    if (!context || !isActive(context) || !request) return;
    const state = requests.get(request);
    if (!state || state.terminal) return;
    emitTerminal(context, state, { outcome: "success", statusCode: state.statusCode });
  });

  channel("undici:request:error").subscribe((message) => {
    const context = storage.getStore();
    const request = requestFromMessage(message);
    if (!context || !isActive(context) || !request) return;
    const state = requests.get(request);
    if (!state || state.terminal) return;
    emitTerminal(context, state, classifyError(errorFromMessage(message)));
  });
}

export function createKimiRequestDiagnosticSession(input: {
  env: NodeJS.ProcessEnv;
  agentId: string;
  sessionId: string;
  emit: (record: KimiRequestDiagnosticRecord) => void;
  now?: () => number;
}): KimiRequestDiagnosticSession | null {
  const targetAgentId = input.env[KIMI_REQUEST_DIAGNOSTIC_AGENT_ID_ENV]?.trim();
  const targetSessionId = input.env[KIMI_REQUEST_DIAGNOSTIC_SESSION_ID_ENV]?.trim();
  // Fail closed: both exact selectors are required. An agent-only selector
  // could silently collect a later session after a restart.
  if (!targetAgentId || !targetSessionId) return null;
  if (targetAgentId !== input.agentId || targetSessionId !== input.sessionId) return null;

  subscribeOnce();
  const context: DiagnosticContext = {
    agentId: input.agentId,
    sessionId: input.sessionId,
    env: input.env,
    emit: input.emit,
    now: input.now ?? Date.now,
    active: true,
    outerAttempt: 1,
    innerAttempt: 0,
  };

  return {
    run<T>(fn: () => T): T {
      if (!isActive(context)) return fn();
      return storage.run(context, fn);
    },
    observeSdkEvent(event): void {
      if (!isActive(context)) return;
      if (!isRecord(event) || typeof event.type !== "string") return;
      if (event.type === "turn.step.started") {
        if ((typeof event.turnId !== "string" && typeof event.turnId !== "number")
          || typeof event.step !== "number") return;
        context.turnId = String(event.turnId);
        context.step = event.step;
        context.outerAttempt = 1;
        context.innerAttempt = 0;
        return;
      }
      if (event.type !== "turn.step.retrying") return;
      if ((typeof event.turnId !== "string" && typeof event.turnId !== "number")
        || typeof event.step !== "number"
        || typeof event.failedAttempt !== "number"
        || typeof event.nextAttempt !== "number"
        || typeof event.maxAttempts !== "number"
        || typeof event.delayMs !== "number") return;
      context.turnId = String(event.turnId);
      context.step = event.step;
      context.outerAttempt = event.nextAttempt;
      context.innerAttempt = 0;
      const errorIdentity = typeof event.errorName === "string" ? event.errorName.toLowerCase() : "";
      const statusCode = typeof event.statusCode === "number" ? event.statusCode : undefined;
      const errorClass = statusCode !== undefined ? undefined
        : errorIdentity.includes("timeout") ? "timeout"
          : errorIdentity.includes("abort") || errorIdentity.includes("cancel") ? "cancelled"
            : errorIdentity ? "connection" : undefined;
      input.emit({
        turnId: String(event.turnId),
        step: event.step,
        outerAttempt: event.nextAttempt,
        innerAttempt: 0,
        correlationId: `${input.sessionId}:${String(event.turnId)}.${event.step}:${event.nextAttempt}.0`,
        outcome: "outer_retrying",
        durationMs: 0,
        failedAttempt: event.failedAttempt,
        nextAttempt: event.nextAttempt,
        maxAttempts: event.maxAttempts,
        retryDelayMs: event.delayMs,
        errorClass,
        ...(statusCode === undefined ? {} : { statusCode }),
      });
    },
    close(): void {
      context.active = false;
    },
  };
}
