import assert from "node:assert/strict";

import type { Channel } from "../src/store/channelStore";
import { resolveRef } from "../src/utils/refTarget";
import type { RefNavContext } from "../src/utils/refTarget";

function contextWith(channels: Channel[], opened: string[]): RefNavContext {
  return {
    channels,
    toDm: (id: string) => { opened.push(id); },
  } as unknown as RefNavContext;
}

const twinDms = [
  { id: "dm-human", type: "dm", name: "dm-1", peerName: "Twin", peerType: "user" },
  { id: "dm-agent", type: "dm", name: "dm-2", peerName: "Twin", peerType: "agent" },
] as unknown as Channel[];

test("a DM ref with an explicit kind opens the DM with that kind of peer", () => {
  const opened: string[] = [];
  const ctx = contextWith(twinDms, opened);

  const agentRef = resolveRef({ dmPeer: "Twin~agent" }, ctx);
  assert.equal(agentRef.resolvable, true);
  void agentRef.navigate?.();
  const humanRef = resolveRef({ dmPeer: "Twin~human" }, ctx);
  void humanRef.navigate?.();

  assert.deepEqual(opened, ["dm-agent", "dm-human"]);
});

test("an unknown kind is left unresolvable rather than opening a same-name DM", () => {
  const ref = resolveRef({ dmPeer: "Twin~bot" }, contextWith(twinDms, []));
  assert.equal(ref.resolvable, false);
});

test("a differently-cased peer name does not resolve (case-sensitive, server authoritative)", () => {
  const ref = resolveRef({ dmPeer: "twin~agent" }, contextWith(twinDms, []));
  assert.equal(ref.resolvable, false, "a handle is case-sensitive; dm:@twin must not match peerName 'Twin'");
});
