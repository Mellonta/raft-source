import { emitStateTransitionTrace } from "./stateTransitionTrace";

const lastReports = new Map<string, { at: number; suppressed: number }>();
export type ConversionDiagnosticStep = "start" | "retry" | "cancel" | "observe" | "cancel-observe";
export function reportConversionFailure(step: ConversionDiagnosticStep, channelId: string, commandId: string | undefined, error: unknown): void {
  try {
    const failure = error as { name?: string; message?: string; stack?: string; response?: { status?: number; data?: { code?: string; error?: string } } } | null;
    const status = failure?.response?.status;
    const code = failure?.response?.data?.code;
    const errorName = failure?.name ?? "Error";
    const key = `${channelId}:${commandId ?? "none"}:${step}:${status ?? "network"}`;
    const now = Date.now();
    const previous = lastReports.get(key);
    if (previous && now - previous.at < 10_000) { previous.suppressed += 1; return; }
    const suppressed = previous?.suppressed ?? 0;
    lastReports.set(key, { at: now, suppressed: 0 });
    if (lastReports.size > 128) lastReports.delete(lastReports.keys().next().value!);
    // Do not log the Axios request/config object: it contains credentials.
    console.warn("[ChannelConversion] request/observation failed", {
      step, channelId, commandId, status, code, errorName, suppressed,
      message: (failure?.message ?? failure?.response?.data?.error ?? String(error)).slice(0, 2000),
      stack: typeof failure?.stack === "string" ? failure.stack.slice(0, 5000) : undefined,
    });
    emitStateTransitionTrace({ domain: "channel", event: `conversion.${step}.failed`, entityId: channelId,
      outcome: "noop", outcomeDetail: `${errorName}:${status ?? "network"}:${code ?? "unknown"}:suppressed=${suppressed}`,
      recoveryAction: "read_authoritative_receipt", join: commandId ? { clientEventId: commandId } : undefined,
    });
  } catch { /* Diagnostics must not alter the conversion outcome. */ }
}
