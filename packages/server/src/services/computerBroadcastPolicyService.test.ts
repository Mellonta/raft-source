// Exercise upstream mechanisms explicitly; mellontaPrivacy.test.ts verifies the shipped policy.
vi.mock("@botiverse/raft-shared", async (importOriginal) => ({
  ...await importOriginal<typeof import("@botiverse/raft-shared")>(),
  DISTRIBUTION_POLICY: { forkReleases: false, managedMcp: true, diagnosticUploads: true, tracing: true, productAnalytics: true, upstreamServices: true, externalAvatars: true },
}));

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { dbTest } from "../test/integration/dbTest";
import { featureFlagRules, featureFlags } from "../db/schema";
import { REMOTE_COMPUTER_UPGRADE_V2_FEATURE_FLAG_KEY } from "./featureFlagService";
import {
  COMPUTER_HANDS_MAIN_URL,
  evaluateBroadcastPolicy,
  isQueuedComputerUpgradePolicyCompatible,
  normalizeComputerPlatform,
  type ComputerHandsResolutionDependencies,
  type EvaluateComputerBroadcastPolicyInput,
} from "./computerBroadcastPolicyService";

// Every test that exercises Hands resolution now sits BEHIND the broadcast gate
// (task #804). These open the gate explicitly so they remain tests of resolution
// and nothing else; the gate itself is tested at the bottom of this file.
function evaluateWithOpenGate(
  input: EvaluateComputerBroadcastPolicyInput,
  deps: ComputerHandsResolutionDependencies,
) {
  return evaluateBroadcastPolicy(input, { isBroadcastEnabled: () => true, ...deps });
}

function release() {
  return {
    app: { slug: "raft-computer-cli", platform: "node" }, channel: "main",
    build: { id: "build-31", version: "1.0.31" },
    scoped: { release_id: "release-31" },
    assets: [{ platform: "darwin", arch: "arm64", variant: null, filetype: "binary",
      sha256: "a".repeat(64), size_bytes: 100, download_url: "https://hands.build/artifact" }],
  };
}
function input(overrides: Partial<EvaluateComputerBroadcastPolicyInput> = {}): EvaluateComputerBroadcastPolicyInput {
  return { source: { version: "1.0.23", observedAt: "2026-01-01T00:00:00Z", provenance: "owner_connection" },
    platform: { os: "macos", architecture: "arm64" }, now: new Date("2026-09-10T00:00:00Z"), ...overrides };
}
function respond(body = release()): typeof fetch {
  return async (url) => {
    assert.equal(url, COMPUTER_HANDS_MAIN_URL);
    assert.equal(new URL(String(url)).searchParams.get("channel"), "main");
    return Response.json(body);
  };
}

test("legacy source with no Server matrix row resolves the current Hands stable (main) release", async () => {
  const result = await evaluateWithOpenGate(input(), { fetchFn: respond() });
  assert.equal(result.eligibility, "eligible");
  assert.equal(result.targetVersion, "1.0.31");
  assert.equal(result.policyRow, null);
  assert.equal(result.handsRelease?.releaseId, "release-31");
  assert.equal(result.handsRelease?.sha256, "a".repeat(64));
});

test("all five supported platform artifacts are selected by exact OS/architecture", async () => {
  for (const [os, platform, architecture] of [
    ["macos", "darwin", "arm64"], ["macos", "darwin", "x64"],
    ["linux", "linux", "arm64"], ["linux", "linux", "x64"], ["windows", "win32", "x64"],
  ] as const) {
    const body = release(); body.assets[0]!.platform = platform; body.assets[0]!.arch = architecture;
    assert.equal((await evaluateWithOpenGate(input({ platform: { os, architecture } }),
      { fetchFn: respond(body) })).eligibility, "eligible");
  }
});

test("rejects missing, mismatched, and duplicate raw platform artifacts", async () => {
  for (const change of [
    (body: ReturnType<typeof release>) => { body.assets = []; },
    (body: ReturnType<typeof release>) => { body.assets[0]!.arch = "x64"; },
    (body: ReturnType<typeof release>) => { body.assets.push({ ...body.assets[0]! }); },
  ]) {
    const body = release(); change(body);
    const result = await evaluateWithOpenGate(input(), { fetchFn: respond(body) });
    assert.equal(result.eligibility, "no_broadcast"); assert.equal(result.reasonCode, "hands_artifact_missing");
  }
});

test("rejects malformed version, identity, size, origin channel and app", async () => {
  for (const change of [
    (body: ReturnType<typeof release>) => { body.build.version = "1.0.031"; },
    (body: ReturnType<typeof release>) => { body.build.version = "1.0.31-01"; },
    (body: ReturnType<typeof release>) => { body.assets[0]!.sha256 = "bad"; },
    (body: ReturnType<typeof release>) => { body.assets[0]!.size_bytes = 0; },
    (body: ReturnType<typeof release>) => { body.assets[0]!.download_url = "http://hands.build/artifact"; },
    // task #805: an alpha response must never be projected as the stable target.
    (body: ReturnType<typeof release>) => { body.channel = "alpha"; },
    (body: ReturnType<typeof release>) => { body.app.slug = "other"; },
  ]) {
    const body = release(); change(body);
    assert.equal((await evaluateWithOpenGate(input(), { fetchFn: respond(body) })).reasonCode, "hands_response_invalid");
  }
});

test("Hands HTTP/network/JSON failures never fall back to a compiled target or CDN", async () => {
  for (const fetchFn of [
    async () => new Response("unavailable", { status: 503 }),
    async () => { throw new Error("network unavailable"); },
    async () => new Response("not JSON"),
  ] satisfies Array<typeof fetch>) {
    const result = await evaluateWithOpenGate(input(), { fetchFn });
    assert.equal(result.eligibility, "no_broadcast"); assert.equal(result.targetVersion, null);
  }
});

test("deadline aborts the actual pending request", async () => {
  let aborted = false;
  const fetchFn: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
  });
  const result = await evaluateWithOpenGate(input(), { fetchFn, timeoutMs: 10 });
  assert.equal(aborted, true); assert.equal(result.reasonCode, "hands_unavailable");
});

test("current or newer Computer is not downgraded, including prerelease precedence", async () => {
  for (const [source, target, eligible] of [
    ["1.0.31", "1.0.31", false], ["1.0.32", "1.0.31", false],
    ["1.0.31-rc.2", "1.0.31", true], ["1.0.31", "1.0.31-rc.2", false],
    ["1.0.31-rc.9", "1.0.31-rc.10", true], ["1.0.31+build1", "1.0.31+build2", false],
  ] as const) {
    const body = release(); body.build.version = target;
    const result = await evaluateWithOpenGate(input({ source: { version: source, observedAt: null, provenance: null } }), { fetchFn: respond(body) });
    assert.equal(result.eligibility === "eligible", eligible, `${source} -> ${target}`);
  }
});

test("requested target cannot override the active Hands stable release", async () => {
  assert.equal((await evaluateWithOpenGate(input({ requestedTargetVersion: "1.0.28" }), { fetchFn: respond() })).reasonCode, "requested_target_mismatch");
});

test("unknown source/platform is rejected before fetching", async () => {
  for (const value of [input({ source: null }), input({ source: { version: "invalid", observedAt: null, provenance: null } }), input({ platform: null })]) {
    const result = await evaluateWithOpenGate(value, { fetchFn: async () => { assert.fail("must not fetch"); } });
    assert.equal(result.eligibility, "no_broadcast");
  }
});

test("queued dispatch preserves exact release identity, rejects old matrix receipts and changed assets", async () => {
  const original = await evaluateWithOpenGate(input(), { fetchFn: respond() });
  const next = { ...original, sourceObservedAt: "2026-09-10T01:00:00Z" };
  assert.equal(isQueuedComputerUpgradePolicyCompatible(original, next), true);
  for (const changed of [
    { ...next, sourceVersion: "1.0.24" },
    { ...next, handsRelease: { ...next.handsRelease!, releaseId: "other-release" } },
    { ...next, handsRelease: { ...next.handsRelease!, sha256: "b".repeat(64) } },
    { ...next, handsRelease: undefined },
  ]) assert.equal(isQueuedComputerUpgradePolicyCompatible(original, changed), false);
  assert.equal(isQueuedComputerUpgradePolicyCompatible({ ...original, handsRelease: undefined }, next), false);
});

test("platform normalization understands existing daemon OS strings", () => {
  assert.deepEqual(normalizeComputerPlatform("Darwin arm64"), { os: "macos", architecture: "arm64" });
  assert.deepEqual(normalizeComputerPlatform("linux x86_64"), { os: "linux", architecture: "x64" });
  assert.equal(normalizeComputerPlatform("linux"), null);
});

// ---------------------------------------------------------------------------
// Broadcast gate (task #804).
//
// Context that makes these tests load-bearing: the previous way to keep Computer
// upgrades dark was a checked-in policy artifact holding zero rows. PR #7571
// deleted that file while replacing the allowlist with Hands resolution, and with
// it the only off switch — so the web Upgrade button came back on its own. These
// tests exist so that the replacement switch cannot be deleted the same way
// without something going red.
// ---------------------------------------------------------------------------

test("a closed gate blocks the broadcast without contacting Hands at all", async () => {
  // Asserting only `no_broadcast` would not be enough: an implementation that
  // fetched Hands first and discarded the result at the end would still pass.
  // The fetchFn below is the tooth — it fails the test if it is ever called.
  const result = await evaluateBroadcastPolicy(input(), {
    isBroadcastEnabled: () => false,
    fetchFn: async () => { assert.fail("a closed gate must not reach Hands"); },
  });
  assert.equal(result.eligibility, "no_broadcast");
  assert.equal(result.reasonCode, "broadcast_disabled");
  assert.equal(result.targetVersion, null);
  assert.equal(result.handsRelease, undefined);
});

test("the gate closes before source and platform validation, so a malformed machine still reports the gate", async () => {
  // Ordering matters for diagnosis: if the gate ran after these checks, a closed
  // gate would surface as `source_missing` and operators would chase the wrong
  // thing. Positive control: the same inputs with the gate open report the
  // input-shaped reasons instead.
  for (const value of [input({ source: null }), input({ platform: null })]) {
    const closed = await evaluateBroadcastPolicy(value, {
      isBroadcastEnabled: () => false,
      fetchFn: async () => { assert.fail("must not fetch"); },
    });
    assert.equal(closed.reasonCode, "broadcast_disabled");

    const open = await evaluateWithOpenGate(value, {
      fetchFn: async () => { assert.fail("must not fetch"); },
    });
    assert.notEqual(open.reasonCode, "broadcast_disabled");
    assert.equal(open.eligibility, "no_broadcast");
  }
});

test("an unreadable gate fails closed under its own reason code", async () => {
  // "Someone turned this off" and "the flag store was unreachable" both stop the
  // broadcast, but they are different incidents. Collapsing them into one code
  // would make a database outage indistinguishable from a deliberate decision in
  // stored receipts and dispatch-failure reasons.
  const result = await evaluateBroadcastPolicy(input(), {
    isBroadcastEnabled: () => { throw new Error("flag store unreachable"); },
    fetchFn: async () => { assert.fail("an unreadable gate must not reach Hands"); },
  });
  assert.equal(result.eligibility, "no_broadcast");
  assert.equal(result.reasonCode, "broadcast_gate_unavailable");
  assert.notEqual(result.reasonCode, "broadcast_disabled");
});

test("the gate receives the serverId, so it can be opened per server rather than only globally", async () => {
  // A gate evaluated without a serverId cannot reach a flag default at all — it
  // would be closable but never openable. Asserting the value reaches the gate is
  // what keeps that regression visible.
  const seen: (string | null)[] = [];
  const allowOnly = "95f993fa-2a68-4797-b8ae-7beb7d984ada";
  for (const serverId of [allowOnly, "11111111-1111-4111-8111-111111111111", null]) {
    const result = await evaluateBroadcastPolicy(input({ serverId }), {
      isBroadcastEnabled: (id) => { seen.push(id); return id === allowOnly; },
      fetchFn: respond(),
    });
    assert.equal(result.eligibility, serverId === allowOnly ? "eligible" : "no_broadcast");
  }
  assert.deepEqual(seen, [allowOnly, "11111111-1111-4111-8111-111111111111", null]);
});

// ---------------------------------------------------------------------------
// Which flag the gate reads. The tests above inject the gate; these drive the
// REAL flag evaluation against a flag store so they prove the key: one flag,
// `remote_computer_upgrade_v2`, gates every Server-initiated upgrade send.
// ---------------------------------------------------------------------------

dbTest("the gate reads remote_computer_upgrade_v2: allowed for the server opens it, nothing else does", async ({ db }) => {
  const serverId = randomUUID();
  const otherServerId = randomUUID();
  const evaluate = (id: string) => evaluateBroadcastPolicy(input({ serverId: id }), { fetchFn: respond() });

  // No flag at all: the default state is dark.
  const missing = await evaluate(serverId);
  assert.equal(missing.eligibility, "no_broadcast");
  assert.equal(missing.reasonCode, "broadcast_disabled");

  // Only remote_computer_upgrade_v2, allowed for exactly this server.
  await db.insert(featureFlags).values({
    key: REMOTE_COMPUTER_UPGRADE_V2_FEATURE_FLAG_KEY,
    description: "test remote computer upgrade v2",
    enabled: true,
    killSwitch: false,
    randomizationUnit: "server",
    defaultEnabled: false,
    salt: "broadcast-policy-v2-gate-test",
  });
  await db.insert(featureFlagRules).values({
    id: randomUUID(),
    flagKey: REMOTE_COMPUTER_UPGRADE_V2_FEATURE_FLAG_KEY,
    stage: "server",
    priority: 0,
    decision: "allow",
    values: [serverId],
  });
  const open = await evaluate(serverId);
  assert.equal(open.eligibility, "eligible");
  assert.equal(open.reasonCode, "eligible");
  assert.equal(open.targetVersion, "1.0.31");

  // Same flag, a server it is not allowed for: still closed.
  const otherServer = await evaluate(otherServerId);
  assert.equal(otherServer.reasonCode, "broadcast_disabled");

  // Turning v2 off closes the gate again, without contacting Hands.
  await db.update(featureFlags).set({ enabled: false })
    .where(eq(featureFlags.key, REMOTE_COMPUTER_UPGRADE_V2_FEATURE_FLAG_KEY));
  const disabled = await evaluateBroadcastPolicy(input({ serverId }), {
    fetchFn: async () => { assert.fail("a closed gate must not reach Hands"); },
  });
  assert.equal(disabled.eligibility, "no_broadcast");
  assert.equal(disabled.reasonCode, "broadcast_disabled");
});
