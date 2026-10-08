// Exercise upstream mechanisms explicitly; mellontaPrivacy.test.ts verifies the shipped policy.
vi.mock("@botiverse/raft-shared", async (importOriginal) => ({
  ...await importOriginal<typeof import("@botiverse/raft-shared")>(),
  DISTRIBUTION_POLICY: { forkReleases: false, managedMcp: true, diagnosticUploads: true, tracing: true, productAnalytics: true, upstreamServices: true, externalAvatars: true },
}));

// The server must never sign a token the worker's shared length gate
// (SCOPE_ATTESTATION_MAX_CHARS) would refuse before even checking it.
import assert from "node:assert/strict";
import { SCOPE_ATTESTATION_MAX_CHARS } from "@botiverse/raft-shared";
import * as scopeAttestation from "./scopeAttestation";

function claims(padding: string): scopeAttestation.ScopeAttestationClaims {
  return {
    v: 1,
    typ: "scope-attestation",
    scope: "daemon-trace-bundle:create",
    sub: "machine:m",
    serverId: "s",
    metadata: { padding },
    nonce: "n",
    exp: Math.floor(Date.now() / 1000) + 60,
  };
}

test("createScopeAttestation refuses to sign over the shared 16 KiB budget, and signs right up to it", () => {
  const previous = process.env.SCOPE_ATTESTATION_SECRET;
  process.env.SCOPE_ATTESTATION_SECRET = "budget-secret";
  try {
    assert.equal(SCOPE_ATTESTATION_MAX_CHARS, 16 * 1024);
    // Find the largest padding that still fits, then prove +1 does not.
    let lo = 0;
    let hi = SCOPE_ATTESTATION_MAX_CHARS;
    const fits = (n: number) => {
      try { return scopeAttestation.createScopeAttestation(claims("x".repeat(n))).length <= SCOPE_ATTESTATION_MAX_CHARS; } catch { return false; }
    };
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (fits(mid)) lo = mid; else hi = mid;
    }
    const atBudget = scopeAttestation.createScopeAttestation(claims("x".repeat(lo)));
    assert.ok(atBudget.length <= SCOPE_ATTESTATION_MAX_CHARS && atBudget.length > SCOPE_ATTESTATION_MAX_CHARS - 8);
    assert.throws(
      () => scopeAttestation.createScopeAttestation(claims("x".repeat(SCOPE_ATTESTATION_MAX_CHARS))),
      (err: unknown) => err instanceof scopeAttestation.ScopeAttestationOverBudgetError && /exceeds/.test((err as Error).message),
    );
  } finally {
    if (previous === undefined) delete process.env.SCOPE_ATTESTATION_SECRET;
    else process.env.SCOPE_ATTESTATION_SECRET = previous;
  }
});
