// Strict Computer version order. The installer decides what to install;
// this stays for the release tooling, whose staging-version comparator
// must mirror it exactly.
import { ComputerServiceError } from "./services/errors";

/**
 * Strict `x.y.z` / `x.y.z-pre` compare (negative / 0 / positive). Computer
 * versions are plain semver; anything unparsable fails typed rather than
 * being silently ordered.
 */
export function compareComputerVersions(a: string, b: string): number {
  const parse = (v: string): { nums: bigint[]; pre: string[] | null } => {
    const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(v);
    if (!m) {
      throw new ComputerServiceError(
        "COMPUTER_VERSION_UNPARSABLE",
        `COMPUTER_VERSION_UNPARSABLE: "${v}" is not x.y.z(-pre) semver`,
      );
    }
    const pre = m[4]?.split(".") ?? null;
    if (pre?.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) {
      throw new ComputerServiceError(
        "COMPUTER_VERSION_UNPARSABLE",
        `COMPUTER_VERSION_UNPARSABLE: "${v}" has a zero-padded numeric pre-release identifier`,
      );
    }
    return { nums: [BigInt(m[1]), BigInt(m[2]), BigInt(m[3])], pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const left = pa.nums[i] ?? 0n;
    const right = pb.nums[i] ?? 0n;
    if (left !== right) return left < right ? -1 : 1;
  }
  // A pre-release sorts below its release. Within pre-release identifiers,
  // numeric compares numerically and below non-numeric; otherwise compare
  // lexically. Equal prefixes sort shorter first (SemVer 2.0.0 §11).
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const count = Math.min(pa.pre.length, pb.pre.length);
  for (let i = 0; i < count; i += 1) {
    const left = pa.pre[i] ?? "";
    const right = pb.pre[i] ?? "";
    if (left === right) continue;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return BigInt(left) < BigInt(right) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left < right ? -1 : 1;
  }
  if (pa.pre.length === pb.pre.length) return 0;
  return pa.pre.length < pb.pre.length ? -1 : 1;
}
