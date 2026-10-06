import type { ParsedEvent } from "./drivers/types";

/**
 * task #1114 — per-process observation of "stdin writes since the last
 * runtime consumption signal".
 *
 * A successful stdin write (idle inbox update, app-inbox notice, busy
 * notification) proves only that bytes reached the runtime. Consumption is
 * proven only by a model-driven runtime event (thinking / text / tool_call /
 * tool_output / turn_end). This watch counts writes between such signals,
 * numbers the episodes, and exposes the result as typed, queryable state.
 * It never acts: no stop, restart, retry or quota decision lives here.
 */
export const DELIVERY_CONSUMPTION_OBSERVATION_THRESHOLD = 3;

export type DeliveryWritePath =
  | "stdin_idle_delivery"
  | "stdin_turn_end_delivery"
  | "busy_stdin_notification"
  | "app_inbox_notice";

export type DeliveryConsumptionKind = "thinking" | "text" | "tool_call" | "tool_output" | "turn_end";

export type DeliveryRuntimeResult =
  | { kind: "completed"; atMs: number; empty: boolean }
  | { kind: "error"; atMs: number; errorClass: string };

export interface DeliveryConsumptionSnapshot {
  episode: number;
  unconsumedDeliveries: number;
  firstUnconsumedAtMs: number | null;
  lastDeliveryAtMs: number | null;
  lastDeliveryKey: string | null;
  lastDeliveryPath: DeliveryWritePath | null;
  lastConsumption: { kind: DeliveryConsumptionKind; atMs: number } | null;
  lastRuntimeResult: DeliveryRuntimeResult | null;
  lastDeliveryError: { atMs: number; errorClass: string } | null;
}

export interface DeliveryWriteObservation extends DeliveryConsumptionSnapshot {
  /** True exactly once per episode, on the write that reaches the threshold. */
  thresholdCrossed: boolean;
}

const CONSUMPTION_KINDS: ReadonlySet<ParsedEvent["kind"]> = new Set<ParsedEvent["kind"]>([
  "thinking",
  "text",
  "tool_call",
  "tool_output",
  "turn_end",
]);

export function isDeliveryConsumptionEvent(kind: ParsedEvent["kind"]): kind is DeliveryConsumptionKind {
  return CONSUMPTION_KINDS.has(kind);
}

export class DeliveryConsumptionWatch {
  private episode = 0;
  private unconsumed = 0;
  private firstUnconsumedAtMs: number | null = null;
  private lastDeliveryAtMs: number | null = null;
  private lastDeliveryKey: string | null = null;
  private lastDeliveryPath: DeliveryWritePath | null = null;
  private lastConsumption: { kind: DeliveryConsumptionKind; atMs: number } | null = null;
  private lastRuntimeResult: DeliveryRuntimeResult | null = null;
  private lastDeliveryError: { atMs: number; errorClass: string } | null = null;
  /** Whether a model-visible event (thinking/text/tool) happened in the current turn. */
  private turnHadContent = false;

  constructor(private readonly threshold: number = DELIVERY_CONSUMPTION_OBSERVATION_THRESHOLD) {}

  /** A stdin write succeeded. Returns the observation to record. */
  recordWrite(key: string | null, path: DeliveryWritePath, nowMs: number): DeliveryWriteObservation {
    if (this.unconsumed === 0) {
      this.episode += 1;
      this.firstUnconsumedAtMs = nowMs;
    }
    this.unconsumed += 1;
    this.lastDeliveryAtMs = nowMs;
    this.lastDeliveryKey = key;
    this.lastDeliveryPath = path;
    return { ...this.snapshot(), thresholdCrossed: this.unconsumed === this.threshold };
  }

  /** A model-driven runtime event arrived for the live launch. */
  recordConsumption(kind: DeliveryConsumptionKind, nowMs: number): void {
    if (kind === "turn_end") {
      this.lastRuntimeResult = { kind: "completed", atMs: nowMs, empty: !this.turnHadContent };
      this.turnHadContent = false;
    } else {
      this.turnHadContent = true;
    }
    this.lastConsumption = { kind, atMs: nowMs };
    this.unconsumed = 0;
    this.firstUnconsumedAtMs = null;
  }

  /** The runtime reported an error: the turn had a result, so the writes were consumed. */
  recordRuntimeError(errorClass: string, nowMs: number): void {
    this.lastRuntimeResult = { kind: "error", atMs: nowMs, errorClass };
    this.turnHadContent = false;
    this.unconsumed = 0;
    this.firstUnconsumedAtMs = null;
  }

  /** The daemon failed to write. Not consumption; recorded separately and never resets the counter. */
  recordDeliveryError(errorClass: string, nowMs: number): void {
    this.lastDeliveryError = { atMs: nowMs, errorClass };
  }

  snapshot(): DeliveryConsumptionSnapshot {
    return {
      episode: this.episode,
      unconsumedDeliveries: this.unconsumed,
      firstUnconsumedAtMs: this.firstUnconsumedAtMs,
      lastDeliveryAtMs: this.lastDeliveryAtMs,
      lastDeliveryKey: this.lastDeliveryKey,
      lastDeliveryPath: this.lastDeliveryPath,
      lastConsumption: this.lastConsumption,
      lastRuntimeResult: this.lastRuntimeResult,
      lastDeliveryError: this.lastDeliveryError,
    };
  }
}
