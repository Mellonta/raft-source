import { describe, expect, it } from "vitest";
import type { MachineToServerMessage } from "@botiverse/raft-shared";
import { LegacyActivitySink, type ActivityProducerContext } from "./activitySink";

function harness(daemonInstanceId: string | null = "daemon-1") {
  const sent: MachineToServerMessage[] = [];
  const events: { name: string; attrs: Record<string, unknown>; status?: string }[] = [];
  let seq = 0;
  const transport = new LegacyActivitySink({
    sendToServer: (msg) => sent.push(msg),
    nextClientSeq: () => ++seq,
    daemonInstanceId: () => daemonInstanceId,
    recordEvent: (name, attrs, status) => events.push({ name, attrs, status }),
    now: () => 1_000,
  });
  return { transport, sent, events };
}

const producer: ActivityProducerContext = {
  present: true,
  serverId: "server-1",
  machineId: "machine-1",
  processInstanceId: "proc-1",
  sessionIdPresent: true,
  runtime: "claude",
};

describe("LegacyActivitySink", () => {
  it("stamps a new fact with sequence, producer fact id, observation time and daemon generation", () => {
    const h = harness();
    const sent = h.transport.publishFact({
      agentId: "a1",
      activityKind: "working",
      detail: "Running command…",
      detailKind: "running_command",
      entries: [],
      launchId: "launch-1",
    }, producer);
    expect(sent).toBe("running_command");
    expect(h.sent).toEqual([{
      type: "agent:activity",
      agentId: "a1",
      detail: "Running command…",
      detailKind: "running_command",
      entries: [],
      launchId: "launch-1",
      daemonInstanceId: "daemon-1",
      clientSeq: 1,
      producerFactId: "daemon_activity:a1:launch-1:daemon-1:1",
      observedAtMs: 1_000,
      isHeartbeat: false,
    }]);
    const produced = h.events.find((e) => e.name === "daemon.agent.activity.produced")!;
    expect(produced.attrs).toMatchObject({
      client_seq: 1,
      producer_fact_id: "daemon_activity:a1:launch-1:daemon-1:1",
      is_heartbeat: false,
      server_id: "server-1",
      ap_present: true,
      correlation_id: "agent:a1:daemonActivity:launch-1:1",
    });
  });

  it("drops a frame with a non-fact detail kind and records why, without a produced trace", () => {
    const h = harness();
    const sent = h.transport.publishFact({
      agentId: "a1",
      activityKind: "working",
      detail: "",
      detailKind: "other",
      entries: [],
      launchId: undefined,
    }, producer);
    expect(sent).toBe(false);
    expect(h.sent).toEqual([]);
    expect(h.events.map((e) => [e.name, e.status])).toEqual([["daemon.agent.activity.dropped", "error"]]);
  });

  it("marks heartbeats as replay provenance and uses the legacy namespace without a launch", () => {
    const h = harness(null);
    h.transport.publishHeartbeat({
      agentId: "a1",
      activityKind: "thinking",
      detail: "",
      detailKind: "thinking_started",
      launchId: undefined,
    }, producer);
    expect(h.sent[0]).toMatchObject({ isHeartbeat: true, clientSeq: 1, producerFactId: "daemon_activity:a1:legacy:1", observedAtMs: 1_000 });
    expect(h.sent[0]).not.toHaveProperty("daemonInstanceId");
    expect(h.events.at(-1)!.attrs).toMatchObject({ is_heartbeat: true, entry_kinds: "" });
  });

  it("answers a probe with the probe id and no observation time", () => {
    const h = harness();
    h.transport.respondToProbe({
      agentId: "a1",
      activityKind: "offline",
      detail: "Agent not running",
      detailKind: "runtime_unavailable",
      launchId: undefined,
    }, "probe-7", { present: false, sessionIdPresent: false });
    expect(h.sent[0]).toMatchObject({ probeId: "probe-7", clientSeq: 1, isHeartbeat: false });
    expect(h.sent[0]).not.toHaveProperty("observedAtMs");
    expect(h.events.at(-1)!.attrs).toMatchObject({ ap_present: false });
  });

  it("passes caller-assigned sequences through unchanged on raw sends", () => {
    const h = harness();
    h.transport.send({
      agentId: "a1",
      activityKind: "working",
      detail: "",
      detailKind: "freshness_hold",
      clientSeq: undefined,
      isHeartbeat: false,
    });
    expect(h.sent[0]).not.toHaveProperty("clientSeq");
    expect(h.sent[0]).toMatchObject({ daemonInstanceId: "daemon-1", detailKind: "freshness_hold" });
  });
});
