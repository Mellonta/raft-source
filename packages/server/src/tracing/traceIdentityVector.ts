// Fixed parity vector for the trace identity derivation (traceIdentity.ts).
// apps/feature-flag-admin must assert this same vector against its own HMAC
// of the provisioned TRACE_AGENT_ID_HASH_KEY / TRACE_SERVER_ID_HASH_KEY, so the
// Worker and the server can never silently disagree on how a hash is computed.
// Changing any value here means the derivation changed: that breaks every
// existing hash and needs the Worker updated in lockstep.
export const TRACE_IDENTITY_PARITY_VECTOR = {
  jwtSecret: "trace-identity-parity-vector",
  id: "5f0c7a52-3b1e-4d8a-9c6f-2e1b0a9d8c7e",
  agentKeyHex: "aa28510fea541dc0a08baff33ad2efa61838e3329e20fca3a3c4627a1b642ccb",
  serverKeyHex: "ff53a0e9e21c24e4f1a987610462e02601a8eaa9aed900f4c10e33cc5e8b842e",
  agentIdHash: "ff70221a03804703",
  serverIdHash: "041c14fe4c2cf07a",
} as const;
