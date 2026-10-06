// Real-Redis teeth for the probe correlation bound in the relay mailbox.
// The Lua write path must reject a response whose probeId differs from the
// request's, otherwise a wrong-probe response occupies the first-response-wins
// slot and the correct result can never land (Cardy F3, review of bd985091).
// Gated like the real-PG suite: CI runs it in the probe-concurrency job with a
// Redis service; local runs need PROBE_RELAY_REAL_REDIS_URL.
import assert from "node:assert/strict";
import Redis from "ioredis";
import {
  asMachineReplyReplicaId,
  asMachineReplyRequestId,
  MachineResponseRelay,
  redisMachineReplyStore,
  type RelayedMachineResponse,
} from "./machineResponseRelay";
import { asProviderProbeId } from "@botiverse/raft-shared";

const REAL_REDIS_URL = process.env.PROBE_RELAY_REAL_REDIS_URL;
const REAL_REDIS_REQUIRED = process.env.PROBE_RELAY_REAL_REDIS_REQUIRED === "1";

function probeResult(requestId: string, probeId: string): RelayedMachineResponse {
  return {
    type: "machine:provider_probe:result",
    requestId,
    probeId: asProviderProbeId(probeId),
    outcome: "success",
    category: null,
    latencyMs: 1,
    responseSha256: "a".repeat(64),
    responseBytes: 2,
    resultDigest: "b".repeat(64),
    authorityEcho: { connectionEpochId: "e", replicaGeneration: "g" },
    daemonVersion: "d",
    computerVersion: "c",
    runtimeVersion: "r",
    reply: "OK",
  };
}

test("real Redis: a wrong-probe response cannot occupy the reply slot", async () => {
  if (!REAL_REDIS_URL) {
    if (REAL_REDIS_REQUIRED) throw new Error("PROBE_RELAY_REAL_REDIS_REQUIRED=1 but PROBE_RELAY_REAL_REDIS_URL is unset");
    return;
  }
  const redis = new Redis(REAL_REDIS_URL);
  const store = redisMachineReplyStore(() => redis);
  const requestId = `req-${Math.random().toString(36).slice(2)}`;
  const owner = new MachineResponseRelay("owner", store, async () => {}, 25);
  const requester = new MachineResponseRelay("requester", store, async () => {}, 25);

  await store.open({
    requestId,
    machineId: "machine-1",
    type: "machine:provider_probe:result",
    probeId: "probe-correct",
    replyReplicaId: "requester",
  } as never, 30_000);

  // Wrong probe first: the Lua write must refuse and leave the slot empty.
  const wrongTarget = await store.write("machine-1", probeResult(requestId, "probe-wrong"), asMachineReplyReplicaId("owner"));
  assert.equal(wrongTarget, null, "a wrong-probe response must not match the request");
  const afterWrong = await store.read(asMachineReplyRequestId(requestId));
  assert.equal(afterWrong?.response, undefined, "a wrong-probe response must not occupy the slot");

  // End-to-end on a FRESH request id (the low-level case owns the first one):
  // the wait registers, a wrong response is dropped, and the correct one still
  // completes the round trip.
  const e2eRequestId = `req-${Math.random().toString(36).slice(2)}`;
  const settled = await requester.request({
    requestId: asMachineReplyRequestId(e2eRequestId),
    machineId: "machine-1",
    type: "machine:provider_probe:result",
    probeId: "probe-correct",
  }, 5_000, async () => {
    await owner.forward("machine-1", probeResult(e2eRequestId, "probe-wrong"), () => {});
    await owner.forward("machine-1", probeResult(e2eRequestId, "probe-correct"), () => {});
  }, () => {});
  assert.equal((settled as { probeId?: string }).probeId, "probe-correct");
  await store.remove(asMachineReplyRequestId(requestId));
  await store.remove(asMachineReplyRequestId(e2eRequestId));
  redis.disconnect();
});
