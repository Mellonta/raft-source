import { createHash } from "node:crypto";
import { canonicalJson, providerProbeRequestDigest, sha256Hex } from "./providerProbes";

afterEach(() => vi.unstubAllGlobals());

test("provider digests match SHA-256 without WebCrypto, including multi-block UTF-8", async () => {
  vi.stubGlobal("crypto", undefined);
  for (const payload of ["", "abc", "Raft 🛶 中文\n", "a".repeat(55), "a".repeat(56), "a".repeat(64), "z".repeat(100_000)]) {
    expect(await sha256Hex(payload)).toBe(createHash("sha256").update(payload).digest("hex"));
  }
});

test("HTTP probe requests preserve the server's canonical digest contract", async () => {
  vi.stubGlobal("crypto", Object.freeze({}));
  const payload = {
    connectionId: "connection", computerId: "computer", runtime: "builtin",
    model: "model", probeKind: "canary" as const,
  };
  const expected = createHash("sha256")
    .update(canonicalJson({ ...payload, schema: "provider-probe-request.v1" }))
    .digest("hex");
  expect(await providerProbeRequestDigest(payload)).toBe(expected);
  expect(await providerProbeRequestDigest({ probeKind: "canary", model: "model", runtime: "builtin", computerId: "computer", connectionId: "connection" })).toBe(expected);
});
