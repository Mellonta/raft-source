import assert from "node:assert/strict";

import { formatDmPeerRef, parseDmPeerRef } from "./dmPeerRef";
import { createRaftDmRefRegex, extractRaftRefTargets, formatRaftRefTarget } from "./raftRefs";

test("a bare DM peer has no kind; an explicit suffix selects agent or human", () => {
  assert.deepEqual(parseDmPeerRef("skyzh"), { ok: true, peerName: "skyzh", peerKind: null });
  assert.deepEqual(parseDmPeerRef("skyzh~agent"), { ok: true, peerName: "skyzh", peerKind: "agent" });
  assert.deepEqual(parseDmPeerRef("skyzh~human"), { ok: true, peerName: "skyzh", peerKind: "human" });
});

test("an unknown or empty kind is refused instead of falling back to the bare name", () => {
  assert.deepEqual(parseDmPeerRef("skyzh~bot"), { ok: false, reason: "unknown_peer_kind", suffix: "bot" });
  assert.deepEqual(parseDmPeerRef("skyzh~"), { ok: false, reason: "unknown_peer_kind", suffix: "" });
  assert.deepEqual(parseDmPeerRef("skyzh~agent~human"), { ok: false, reason: "unknown_peer_kind", suffix: "agent~human" });
  assert.deepEqual(parseDmPeerRef("~agent"), { ok: false, reason: "empty_peer_name" });
  assert.deepEqual(parseDmPeerRef(""), { ok: false, reason: "empty_peer_name" });
});

test("format and parse round-trip for every kind", () => {
  for (const peerKind of [null, "agent", "human"] as const) {
    const parsed = parseDmPeerRef(formatDmPeerRef("skyzh", peerKind));
    assert.deepEqual(parsed, { ok: true, peerName: "skyzh", peerKind });
  }
});

test("rendered DM refs keep an explicit kind as one reference", () => {
  const regex = createRaftDmRefRegex();
  const match = regex.exec("reply in dm:@skyzh~agent please");
  assert.ok(match, "the suffixed ref is recognised");
  assert.equal(match[0].trim().endsWith("dm:@skyzh~agent"), true, match[0]);
  assert.equal(formatRaftRefTarget({ kind: "dm", peerName: "skyzh~agent" }), "dm:@skyzh~agent");
});

test("an unknown kind in text is not a ref, and never degrades into another target", () => {
  for (const text of ["see dm:@Twin~bot", "see dm:@Twin~agentXYZ", "see dm:@Twin~ now", "see dm:@Twin~bot:deadbeef"]) {
    assert.deepEqual(extractRaftRefTargets(text), [], text);
    assert.equal([...text.matchAll(createRaftDmRefRegex())].length, 0, text);
  }
  // Controls on the same shapes: valid kinds and bare names still extract.
  assert.deepEqual(
    extractRaftRefTargets("see dm:@Twin~agent and dm:@Twin~human:deadbeef and dm:@Solo").map((ref) => ref.raw),
    ["dm:@Twin~agent", "dm:@Twin~human:deadbeef", "dm:@Solo"],
  );
});
