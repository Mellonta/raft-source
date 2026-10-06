import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// task #816 — the macOS sign/notarize step receives the classified release
// version. A feature-channel build is stamped <x.y.z>-<channel>.<n>, and the
// run `computer-v1.0.33-constructed-wake-context.2` failed here with
// "Version must be a plain semver". The guard is the FIRST check in the
// script, ahead of the Darwin check, so on Linux an accepted version reaches
// the Darwin error and a rejected version never does.
const script = fileURLToPath(new URL("./sign-notarize-macos.sh", import.meta.url));

function versionGuard(version) {
  const result = spawnSync("bash", [script, "--dir", "/nonexistent", "--version", version], { encoding: "utf8" });
  assert.equal(result.status, 1, `${version}: expected exit 1, got ${result.status}`);
  const stderr = result.stderr;
  if (/Version must be/u.test(stderr)) return "rejected";
  if (/macOS signing must run on Darwin|MACOS_CERT_P12_BASE64/u.test(stderr)) return "accepted";
  throw new Error(`${version}: unexpected stderr: ${stderr}`);
}

test("sign-notarize version guard accepts plain semver and feature-channel versions", () => {
  assert.equal(versionGuard("1.0.33"), "accepted");
  assert.equal(versionGuard("1.0.33-constructed-wake-context.2"), "accepted");
  assert.equal(versionGuard("1.0.33-abc.10"), "accepted");
});

test("sign-notarize version guard rejects other pre-release forms and malformed versions", () => {
  assert.equal(versionGuard("1.0"), "rejected");
  assert.equal(versionGuard("v1.0.33"), "rejected");
  assert.equal(versionGuard("1.0.33-rc.1"), "rejected", "RC builds are stamped with the plain base version");
  assert.equal(versionGuard("1.0.33-constructed-wake-context"), "rejected", "feature versions carry a sequence");
  assert.equal(versionGuard("1.0.33-constructed-wake-context.0"), "rejected");
  assert.equal(versionGuard("1.0.33-Constructed-Wake-Context.1"), "rejected");
  assert.equal(versionGuard("1.0.33-a_b.1"), "rejected");
  assert.equal(versionGuard("1.0.33-constructed-wake-context.1;touch x"), "rejected");
});
