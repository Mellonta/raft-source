// Static lock-order contract for the read-state sequencer (task #93 line B).
//
// Every sequencer function that locks the authority row (lockAuthority) must first take the servers row and the acting
// principal's membership through lockReadMutationServerRow or lockReadMutationAdmissionFence, so no path holds a member
// row and then waits on `servers` through a foreign-key insert while transitionMemberRole holds `servers` FOR UPDATE.
// The only named exemptions are claim, fair claim and compaction: they lock the authority row but never a member row.
// The agent reading for itself is its own case inside the admission fence, not an exemption.
//
// Second rule: no scope read may run ahead of that fence. The unread boundary did, so a removed human was told the scope
// did not exist (surfacing as 500) rather than being refused; only the helpers that run inside an already-fenced
// transaction are exempt, and each exemption is named.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SEQUENCER_SOURCE = fileURLToPath(new URL("./readMutationSequencer.ts", import.meta.url));
const EXEMPT = new Set(["claimNextReadMutation", "claimNextFairReadMutation", "compactTerminalReadMutations"]);
const SERVER_FIRST_CALLS = ["lockReadMutationServerRow(", "lockReadMutationAdmissionFence("];
// A scope read must never run ahead of the membership fence: the unread boundary used to do exactly that, so a removed
// human was told the scope did not exist (surfacing as 500) instead of being refused. Exempt are the helpers that only
// ever run inside an already-fenced transaction — the apply-path boundary captures, the stored-ack bound, the internal
// plural resolver — plus the test-only inspector, and the frontier, which takes the servers row and answers an empty
// frontier rather than admitting anything (fencing it would be a behaviour change, raised separately).
const SCOPE_READ_CALLS = ["resolveAuthorizedReadMutationScope(", "resolveAuthorizedReadMutationScopes("];
const SCOPE_READ_EXEMPT = new Set([
  "resolveAuthorizedReadMutationScope",
  "resolveAuthorizedReadMutationScopes",
  "inspectChannelReadAllScopeAuthorityForTests",
  "boundStoredChannelReadAllAck",
  "captureChannelBoundary",
  "captureDoneBoundary",
  "captureBoundary",
  "captureGlobalBoundary",
  "getReadMutationFrontier",
]);

type FunctionBody = { name: string; body: string };

function topLevelFunctions(source: string): FunctionBody[] {
  const declaration = /^(?:export )?async function (\w+)\(/gm;
  const starts: Array<{ name: string; index: number }> = [];
  for (const match of source.matchAll(declaration)) starts.push({ name: match[1]!, index: match.index! });
  return starts.map((start, i) => ({
    name: start.name,
    body: source.slice(start.index, i + 1 < starts.length ? starts[i + 1]!.index : source.length),
  }));
}

/** Returns the violations of the contract for a sequencer source text. */
export function readMutationLockOrderViolations(source: string): string[] {
  const violations: string[] = [];
  for (const fn of topLevelFunctions(source)) {
    if (fn.name === "lockAuthority" || fn.name === "lockReadMutationServerRow" || fn.name === "lockReadMutationAdmissionFence") continue;
    const authorityIndex = fn.body.indexOf("lockAuthority(");
    if (authorityIndex < 0) continue;
    if (EXEMPT.has(fn.name)) continue;
    const serverFirst = SERVER_FIRST_CALLS
      .map((call) => fn.body.indexOf(call))
      .filter((index) => index >= 0);
    if (serverFirst.length === 0 || Math.min(...serverFirst) > authorityIndex) {
      violations.push(`${fn.name}: lockAuthority is reached before the servers row / membership fence`);
    }
  }
  for (const fn of topLevelFunctions(source)) {
    if (SCOPE_READ_EXEMPT.has(fn.name)) continue;
    const scopeReads = SCOPE_READ_CALLS
      .map((call) => fn.body.indexOf(call))
      .filter((index) => index >= 0);
    if (scopeReads.length === 0) continue;
    const fenceIndex = fn.body.indexOf("lockReadMutationAdmissionFence(");
    if (fenceIndex < 0 || fenceIndex > Math.min(...scopeReads)) {
      violations.push(`${fn.name}: a scope read runs before the membership fence`);
    }
  }
  const fence = topLevelFunctions(source).find((fn) => fn.name === "lockReadMutationAdmissionFence");
  if (!fence) {
    violations.push("lockReadMutationAdmissionFence is missing");
  } else {
    if (!fence.body.includes("lockReadMutationServerRow(")) violations.push("admission fence does not lock the servers row first");
    if (!fence.body.includes("lockActorMembershipRow(")) violations.push("admission fence does not lock the acting human's member row");
    if (!/FROM server_agent_members[\s\S]*FOR SHARE/.test(fence.body)) violations.push("admission fence lost the agent membership case");
  }
  return violations;
}

test("read-state sequencer: no path locks the authority row before the servers row and membership fence (named exemptions only)", () => {
  assert.deepEqual(readMutationLockOrderViolations(readFileSync(SEQUENCER_SOURCE, "utf8")), []);
});

test("the contract turns red when admission, apply or frontier lose the servers-first lock, or the fence loses a case", () => {
  const source = readFileSync(SEQUENCER_SOURCE, "utf8");
  const withoutAdmissionFence = source.replace(/\n\s*await lockReadMutationAdmissionFence\(tx, \{[\s\S]*?\}\);\n/, "\n");
  assert.notEqual(withoutAdmissionFence, source, "fixture could not remove the admission fence call");
  assert.ok(readMutationLockOrderViolations(withoutAdmissionFence).some((v) => v.startsWith("admitReadMutation:")));

  const withoutApplyServerLock = source.replace("await lockReadMutationServerRow(tx, input.claim.serverId);", "");
  assert.notEqual(withoutApplyServerLock, source, "fixture could not remove the apply servers lock");
  assert.ok(readMutationLockOrderViolations(withoutApplyServerLock).some((v) => v.startsWith("executeReadMutationClaim:")));

  const withoutFrontierServerLock = source.replace("await lockReadMutationServerRow(tx, input.serverId);\n    if (!await lockActiveReadMutationPrincipal", "if (!await lockActiveReadMutationPrincipal");
  assert.notEqual(withoutFrontierServerLock, source, "fixture could not remove the frontier servers lock");
  assert.ok(readMutationLockOrderViolations(withoutFrontierServerLock).some((v) => v.startsWith("getReadMutationFrontier:")));

  const withoutUnreadFence = source.replace(
    "    await lockReadMutationAdmissionFence(tx, {\n      serverId: input.serverId,\n      principalKind,\n      principalId: input.principalId,\n    });\n",
    "",
  );
  assert.notEqual(withoutUnreadFence, source, "fixture could not remove the unread boundary fence");
  assert.ok(readMutationLockOrderViolations(withoutUnreadFence)
    .includes("resolveReadMutationUnreadBoundary: a scope read runs before the membership fence"));

  const withoutAgentCase = source.replace(/FROM server_agent_members sam\n\s*WHERE sam\.server_id = \$\{input\.serverId\}::uuid\n\s*AND sam\.agent_id = \$\{input\.principalId\}::uuid\n\s*FOR SHARE/, "FROM server_agent_members sam WHERE false");
  assert.notEqual(withoutAgentCase, source, "fixture could not remove the agent membership case");
  assert.ok(readMutationLockOrderViolations(withoutAgentCase).includes("admission fence lost the agent membership case"));
});
