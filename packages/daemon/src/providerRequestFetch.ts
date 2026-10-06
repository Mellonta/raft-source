import { randomUUID } from "node:crypto";
import { providerRequestId, type ProviderRequestActivity } from "@botiverse/raft-shared";

export type ProviderRequestObserver = (activity: ProviderRequestActivity) => void;

/** Passive HTTP request facts. The SDK still owns cancellation, errors and retries. */
export async function providerRequestFetch(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: { provider: string; observe?: ProviderRequestObserver },
): Promise<Response> {
  const startedAt = new Date().toISOString();
  const provider = /^[a-z0-9_-]{1,64}$/.test(options.provider) ? options.provider : "custom";
  const base = { schemaVersion: 1 as const, requestId: providerRequestId(randomUUID()), provider, startedAt };
  const signal = init?.signal === null ? undefined
    : init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const observe = (phase: ProviderRequestActivity["phase"], httpStatus?: number) => {
    try {
      options.observe?.({ ...base, phase, observedAt: new Date().toISOString(), ...(httpStatus ? { httpStatus } : {}) });
    } catch { /* An unavailable diagnostic sink must not alter a provider request. */ }
  };
  observe("waiting");
  try {
    // Preserve the original body source and all SDK options, including signal.
    // Rebuilding a Request converts string bodies to streams and breaks native
    // fetch's handling of 401 authentication responses.
    const response = await fetchImpl(input, init);
    observe(response.ok ? "responding" : "failed", response.status);
    // Fetch resolves at headers. Leave body ownership, metadata and identity
    // intact; later stream outcomes remain the SDK's responsibility.
    return response;
  } catch (error) {
    observe(signal?.aborted ? "cancelled" : "failed");
    throw error;
  }
}
