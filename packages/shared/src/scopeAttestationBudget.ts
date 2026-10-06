/**
 * Length budget, in characters, of one server-signed scope attestation token.
 *
 * Shared by both sides of the hop: the trace-upload worker refuses a longer
 * token BEFORE verifying it (`readString(attestation, ..., MAX)`), and the
 * server refuses to sign one, so a token the worker would reject is never
 * minted. Optional, unbounded diagnostics therefore never belong in signed
 * claims (see `feedbackMachineEvidence.ts`). Raising this number needs both
 * deployments; do not raise it to make room for diagnostics.
 */
export const SCOPE_ATTESTATION_MAX_CHARS = 16 * 1024;
