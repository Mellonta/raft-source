// Mellonta's self-hosted distribution. These are build-time decisions, not
// environment defaults: installing the binary is enough to apply the policy.
export const DISTRIBUTION_POLICY = {
  managedMcp: false,
  diagnosticUploads: false,
} as const;
