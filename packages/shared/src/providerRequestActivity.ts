declare const providerRequestIdBrand: unique symbol;
/** One HTTP request attempt. Never a prompt or URL. */
export type ProviderRequestId = string & { readonly [providerRequestIdBrand]: true };

export function providerRequestId(value: string): ProviderRequestId {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Invalid provider request identity");
  }
  return value as ProviderRequestId;
}

/** Value-free fetch facts. A received response does not prove model success or consumption. */
export interface ProviderRequestActivity {
  schemaVersion: 1;
  requestId: ProviderRequestId;
  /** Validated catalog provider key; custom endpoints use `custom`. No hostnames. */
  provider: string;
  phase: "waiting" | "responding" | "failed" | "cancelled";
  startedAt: string;
  observedAt: string;
  httpStatus?: number;
}
