#!/usr/bin/env -S node --import=@oxc-node/core/register
// Incident helper: id -> the keyed hash its spans carry (agent_id_hash by
// default, server_id_hash with --kind server), so you can find them in
// ScopeDB. Needs the same JWT_SECRET as the servers. There is deliberately no
// reverse direction here.
import "dotenv/config";
import { traceIdentityHash, type TraceIdentityKind } from "../src/tracing/traceIdentity";

const args = process.argv.slice(2);
let kind: TraceIdentityKind = "agent_id_hash";
const kindAt = args.indexOf("--kind");
if (kindAt !== -1) {
  const value = args[kindAt + 1];
  if (value !== "agent" && value !== "server") {
    console.error("--kind must be agent or server");
    process.exit(2);
  }
  kind = value === "server" ? "server_id_hash" : "agent_id_hash";
  args.splice(kindAt, 2);
}
if (!args.length) {
  console.error("usage: pnpm --filter @botiverse/raft-server trace:agent-id-hash [--kind agent|server] <id>...");
  process.exit(2);
}
for (const id of args) {
  const hash = traceIdentityHash(kind, id);
  if (!hash) {
    console.error("JWT_SECRET is not set; cannot derive the trace identity key");
    process.exit(1);
  }
  console.log(`${id}\t${hash}`);
}
