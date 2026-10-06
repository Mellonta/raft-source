# Activity hand-off (RFC 069 §7)

The process manager decides what an agent is doing; this folder decides how
each fact leaves the daemon.

- `agentActivityProducer.ts` builds the legacy `agent:activity` frame from a fact
  and drops non-fact detail kinds.
- `activitySink.ts` defines the `ActivitySink` interface the process manager hands
  facts to, and `LegacyActivitySink`, the V1 implementation (client sequence,
  producer fact id, heartbeat and probe-reply frames, produced trace).

The activity sync V2 sink (numbered log with ack and resume) belongs here too.
