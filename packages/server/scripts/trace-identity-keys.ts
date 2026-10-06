#!/usr/bin/env -S node --import=@oxc-node/core/register
// For whoever holds the server ECS secrets: prints the two derived trace
// identity keys so they can be provisioned on the Feature Flag Admin Worker
// (apps/feature-flag-admin), which resolves agent_id_hash / server_id_hash for
// operators. The keys are HKDF-derived from JWT_SECRET with their own salt and
// info (domain-separated), so they can only produce trace hashes, never sign or
// verify a JWT. JWT_SECRET itself is never printed.
//
// Refuses to write to a pipe or file so the keys don't land in logs by accident.
import "dotenv/config";
import { exportTraceIdentityKeyHex } from "../src/tracing/traceIdentity";

const SECRETS = [
  ["TRACE_AGENT_ID_HASH_KEY", "agent_id_hash"],
  ["TRACE_SERVER_ID_HASH_KEY", "server_id_hash"],
] as const;

if (!process.stdout.isTTY) {
  console.error("refusing to print trace identity keys to a non-TTY stdout; run in an interactive terminal");
  process.exit(2);
}

const lines: string[] = [];
for (const [name, kind] of SECRETS) {
  const key = exportTraceIdentityKeyHex(kind);
  if (!key) {
    console.error("JWT_SECRET is not set; cannot derive the trace identity keys");
    process.exit(1);
  }
  lines.push(`${name}=${key}`);
}

for (const line of lines) console.log(line);
for (const [name] of SECRETS) {
  console.error(`set with: wrangler secret put ${name}`);
}
