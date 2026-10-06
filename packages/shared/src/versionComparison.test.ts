import assert from "node:assert/strict";

import { bothComputerVersionsKnown, compareComputerVersions, COMPUTER_REMOTE_UPGRADE_MIN_VERSION, isComputerOutdated, isDaemonOutdated, isRemoteUpgradeSupported } from "./index";

test("isComputerOutdated: prefer-miss-over-mistrigger when either side is null/empty", () => {
  // We never want to flash "update available" on a stale-row Computer where
  // `computerVersion` hasn't synced yet, and we never want to claim
  // "update available" before the npm probe has cached `latestComputerVersion`.
  // Both directions return false when either side is missing.
  assert.equal(isComputerOutdated(null, "0.0.62"), false);
  assert.equal(isComputerOutdated(undefined, "0.0.62"), false);
  assert.equal(isComputerOutdated("0.0.61", null), false);
  assert.equal(isComputerOutdated("0.0.61", undefined), false);
  assert.equal(isComputerOutdated(null, null), false);
});

test("isComputerOutdated: returns true only when current strictly < latest", () => {
  assert.equal(isComputerOutdated("0.0.61", "0.0.62"), true);
  assert.equal(isComputerOutdated("0.0.62", "0.0.62"), false, "equal versions are NOT outdated");
  assert.equal(isComputerOutdated("0.0.63", "0.0.62"), false, "newer-than-latest (e.g. dev build) is NOT outdated");
  // Major / minor / patch all participate.
  assert.equal(isComputerOutdated("0.55.5", "0.55.6"), true);
  assert.equal(isComputerOutdated("0.54.0", "0.55.0"), true);
  assert.equal(isComputerOutdated("0.55.0", "1.0.0"), true);
});

test("isComputerOutdated mirrors isDaemonOutdated semantics — same source of truth, no per-surface fork", () => {
  // Yingjun guardian note (#wg-raft-computer:69c76b6e msg=cefcdffc): don't
  // fork "what counts as newer" between web and menu-bar; the menu-bar
  // (`semverGreater` in menuModel) and the web (`isComputerOutdated`) must
  // agree, otherwise the menu says "update available" while the dashboard
  // says nothing.
  for (const [a, b] of [
    ["0.0.61", "0.0.62"],
    ["0.0.62", "0.0.62"],
    ["0.0.63", "0.0.62"],
    ["1.0.0", "0.99.99"],
    ["0.99.99", "1.0.0"],
  ] as const) {
    assert.equal(isComputerOutdated(a, b), isDaemonOutdated(a, b), `same answer for (${a}, ${b})`);
  }
});

test("isComputerOutdated: malformed current/latest must NOT mistrigger 'outdated' (Yingjun gap msg=98a9f1ab)", () => {
  // Pre-fix the parser was `.split(".").map(Number)` which produced [NaN]
  // for non-numeric segments and made the loop misbehave: `"abc"` vs
  // `"0.0.62"` returned true (claims outdated → flashes "update available"
  // on a row whose version we can't even parse). Strict `MAJOR.MINOR.PATCH`
  // matching kills the failure mode.
  assert.equal(isComputerOutdated("abc", "0.0.62"), false, "malformed current must not claim outdated");
  assert.equal(isComputerOutdated("0.0.62", "abc"), false, "malformed latest must not claim outdated");
  assert.equal(isComputerOutdated("abc", "def"), false, "both malformed must not claim outdated");
  // Future tags (e.g. pre-release) parse strictly only when MAJOR.MINOR.PATCH;
  // anything more elaborate is treated as malformed (prefer-miss).
  assert.equal(isComputerOutdated("0.0.62-rc1", "0.0.62"), false, "pre-release/qualifier tag is treated as malformed");
  assert.equal(isComputerOutdated("0.0.62", "0.0.63-rc1"), false);
});

test("bothComputerVersionsKnown: positive proof both sides parse as semver", () => {
  // The web upgrade-button gate's `knownNoUpgrade` precondition. Returns
  // true ONLY when both inputs are present AND parse strictly. Anything
  // else → button must NOT be hard-disabled (let the server decide
  // capability via the existing 409 gate).
  assert.equal(bothComputerVersionsKnown("0.0.61", "0.0.62"), true);
  assert.equal(bothComputerVersionsKnown("0.0.62", "0.0.62"), true);
  assert.equal(bothComputerVersionsKnown(null, "0.0.62"), false);
  assert.equal(bothComputerVersionsKnown("0.0.61", null), false);
  assert.equal(bothComputerVersionsKnown("", "0.0.62"), false);
  assert.equal(bothComputerVersionsKnown("0.0.61", ""), false);
  assert.equal(bothComputerVersionsKnown(undefined, undefined), false);
  // Malformed = unknown — same prefer-miss principle.
  assert.equal(bothComputerVersionsKnown("abc", "0.0.62"), false);
  assert.equal(bothComputerVersionsKnown("0.0.62", "abc"), false);
  assert.equal(bothComputerVersionsKnown("0.0.62-rc1", "0.0.62"), false);
});

test("isRemoteUpgradeSupported: null when unknown, false below the first v2-capable release, true at or above", () => {
  // Unknown version is a distinct answer: the web shows neither the button
  // state nor the local-upgrade hint for it.
  assert.equal(isRemoteUpgradeSupported(null), null);
  assert.equal(isRemoteUpgradeSupported(undefined), null);
  assert.equal(isRemoteUpgradeSupported(""), null);
  assert.equal(isRemoteUpgradeSupported("  "), null);
  assert.equal(isRemoteUpgradeSupported("1.0.36"), false);
  assert.equal(isRemoteUpgradeSupported("0.9.99"), false);
  assert.equal(isRemoteUpgradeSupported(COMPUTER_REMOTE_UPGRADE_MIN_VERSION), true, "the threshold release itself is supported");
  assert.equal(isRemoteUpgradeSupported("1.0.38"), true);
  assert.equal(isRemoteUpgradeSupported("2.0.0"), true);
});

test("isRemoteUpgradeSupported reads full SemVer and fails closed: a prerelease sorts below its release", () => {
  // Below the threshold, with or without a prerelease suffix.
  assert.equal(isRemoteUpgradeSupported("1.0.36-rc.1"), false);
  assert.equal(isRemoteUpgradeSupported("1.0.36-staging.20260901000000.sha.0123456789ab"), false);
  // 1.0.37-rc.1 precedes 1.0.37, the first v2-capable release.
  assert.equal(isRemoteUpgradeSupported("1.0.37-rc.1"), false);
  assert.equal(isRemoteUpgradeSupported("1.0.37"), true);
  assert.equal(isRemoteUpgradeSupported(" 1.0.37 "), true, "surrounding whitespace is not a different version");
  assert.equal(isRemoteUpgradeSupported("1.0.38-rc.1"), true);
  assert.equal(isRemoteUpgradeSupported("1.0.41-staging.20261003090435.sha.4f9786e3e10a"), true);
  assert.equal(isRemoteUpgradeSupported("1.0.37+build.5"), true);
  // Not SemVer: never supported.
  for (const garbage of ["abc", "1.0", "1.0.x", "01.0.40", "1.0.40-", "1.0.40-rc.01", "v1.0.40"]) {
    assert.equal(isRemoteUpgradeSupported(garbage), false, garbage);
  }
});

test("compareComputerVersions: SemVer precedence (the server's already_current order)", () => {
  const cases: Array<[string, string, number]> = [
    ["1.0.41-staging.20261003090435.sha.4f9786e3e10a", "1.0.40", 1],
    ["1.0.40-staging.20260930120000.sha.0123456789ab", "1.0.40", -1],
    ["1.0.40-rc.1", "1.0.40", -1],
    ["1.0.40-rc.2", "1.0.40-rc.10", -1],
    ["1.0.40-alpha", "1.0.40-alpha.1", -1],
    ["1.0.40-1", "1.0.40-alpha", -1],
    ["1.0.40+a", "1.0.40+b", 0],
    ["1.0.40", "1.0.40", 0],
    ["1.10.0", "1.9.0", 1],
  ];
  for (const [a, b, expected] of cases) {
    assert.equal(compareComputerVersions(a, b), expected, `${a} vs ${b}`);
    assert.equal(compareComputerVersions(b, a), -expected || 0, `${b} vs ${a}`);
  }
});
