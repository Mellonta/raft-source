// Mellonta's self-hosted distribution. These are build-time decisions, not
// environment defaults: installing the binary is enough to apply the policy.
export const DISTRIBUTION_POLICY = Object.freeze({
  forkReleases: true,
  managedMcp: false,
  diagnosticUploads: false,
  tracing: false,
  productAnalytics: false,
  upstreamServices: false,
  externalAvatars: false,
} as const);

/** Refuse old vendor endpoints in saved client configuration or update overrides. */
export function assertNoVendorServiceUrl(value: string): void {
  if (DISTRIBUTION_POLICY.upstreamServices) return;
  const hostname = new URL(value).hostname.toLowerCase();
  const vendorDomains = ["raft.build", "slock.ai", "botiverse.dev", "hands.build", "slock-server-staging.fly.dev"];
  if (vendorDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    throw new Error("Botiverse-hosted services are disabled in this self-hosted build. Configure your own server or the Mellonta release source.");
  }
}
