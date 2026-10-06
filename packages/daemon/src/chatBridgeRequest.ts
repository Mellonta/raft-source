import { logger } from "./logger";

export const DEFAULT_CHAT_BRIDGE_TOOL_TIMEOUT_MS = Number.parseInt(
  process.env.SLOCK_CHAT_BRIDGE_TOOL_TIMEOUT_MS || "",
  10,
) || 60_000;

export class ChatBridgeToolTimeoutError extends Error {
  readonly toolName: string;
  readonly target: string | null;
  readonly timeoutMs: number;
  readonly durationMs: number;

  constructor(toolName: string, target: string | null, timeoutMs: number, durationMs: number) {
    super(`${toolName} timed out after ${timeoutMs}ms${target ? ` (target: ${target})` : ""}`);
    this.name = "ChatBridgeToolTimeoutError";
    this.toolName = toolName;
    this.target = target;
    this.timeoutMs = timeoutMs;
    this.durationMs = durationMs;
  }
}

/**
 * A non-2xx answer from a JSON endpoint. Raised from the STATUS, before the
 * body is parsed: proxies and body parsers answer with HTML error pages, and
 * parsing those first turned e.g. a 413 into "Unexpected token '<'".
 */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly toolName: string;
  /** The `error` string of a JSON error body, when there was one. */
  readonly serverError: string | null;

  constructor(toolName: string, status: number, serverError: string | null) {
    super(`${toolName} failed with HTTP ${status}${serverError ? `: ${serverError}` : ""}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.toolName = toolName;
    this.serverError = serverError;
  }
}

async function readErrorBodyMessage(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string") {
      return (parsed as { error: string }).error.slice(0, 300);
    }
  } catch {
    // Not JSON (an HTML error page, an empty body): the status says it all.
  }
  return null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface ExecuteJsonRequestOptions {
  toolName: string;
  target?: string | null;
  timeoutMs?: number;
  fetchImpl: FetchLike;
  now?: () => number;
  warn?: (message: string) => void;
}

type ExecuteResponseRequestOptions = ExecuteJsonRequestOptions;

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export async function executeJsonRequest<T>(
  url: string,
  init: RequestInit,
  {
    toolName,
    target = null,
    timeoutMs = DEFAULT_CHAT_BRIDGE_TOOL_TIMEOUT_MS,
    fetchImpl,
    now = () => Date.now(),
    warn = (message) => logger.warn(message),
  }: ExecuteJsonRequestOptions,
): Promise<{ response: Response; data: T; durationMs: number }> {
  const startedAt = now();
  const timeoutController = new AbortController();
  const signals = [timeoutController.signal];
  if (init.signal) signals.push(init.signal);
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  const timeout = setTimeout(() => {
    timeoutController.abort();
  }, timeoutMs);
  timeout.unref?.();

  try {
    const response = await fetchImpl(url, { ...init, signal });
    if (!response.ok) {
      throw new HttpStatusError(toolName, response.status, await readErrorBodyMessage(response));
    }
    const data = await response.json() as T;
    return { response, data, durationMs: now() - startedAt };
  } catch (err) {
    const durationMs = now() - startedAt;
    if (timeoutController.signal.aborted && !init.signal?.aborted) {
      warn(
        `[ChatBridgeTimeout] tool=${toolName} target=${target ?? "-"} duration_ms=${durationMs} timeout_ms=${timeoutMs} outcome=timeout`,
      );
      throw new ChatBridgeToolTimeoutError(toolName, target, timeoutMs, durationMs);
    }

    warn(
      `[ChatBridgeError] tool=${toolName} target=${target ?? "-"} duration_ms=${durationMs} outcome=error error=${describeError(err)}`,
    );
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export async function executeResponseRequest(
  url: string,
  init: RequestInit,
  {
    toolName,
    target = null,
    timeoutMs = DEFAULT_CHAT_BRIDGE_TOOL_TIMEOUT_MS,
    fetchImpl,
    now = () => Date.now(),
    warn = (message) => logger.warn(message),
  }: ExecuteResponseRequestOptions,
): Promise<{ response: Response; durationMs: number }> {
  const startedAt = now();
  const timeoutController = new AbortController();
  const signals = [timeoutController.signal];
  if (init.signal) signals.push(init.signal);
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  const timeout = setTimeout(() => {
    timeoutController.abort();
  }, timeoutMs);
  timeout.unref?.();

  try {
    const response = await fetchImpl(url, { ...init, signal });
    return { response, durationMs: now() - startedAt };
  } catch (err) {
    const durationMs = now() - startedAt;
    if (timeoutController.signal.aborted && !init.signal?.aborted) {
      warn(
        `[ChatBridgeTimeout] tool=${toolName} target=${target ?? "-"} duration_ms=${durationMs} timeout_ms=${timeoutMs} outcome=timeout`,
      );
      throw new ChatBridgeToolTimeoutError(toolName, target, timeoutMs, durationMs);
    }

    warn(
      `[ChatBridgeError] tool=${toolName} target=${target ?? "-"} duration_ms=${durationMs} outcome=error error=${describeError(err)}`,
    );
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
