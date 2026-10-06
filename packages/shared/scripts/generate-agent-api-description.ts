// Language-neutral description of the credential-derived Agent API.
//
// One JSON document, derived from the same zod contract that validates the
// Server routes and drives the CLI and the TypeScript SDK, so a Python or Go
// SDK (or a tool-schema generator) reads the same source instead of chasing
// the TypeScript types by hand. Per route: method, path, client binding,
// capability, operating metadata (`sideEffect` / `idempotency` / `audience`),
// MCP-style tool annotations, and JSON Schema (draft 2020-12) for params,
// query, body, and response.
//
// Regenerate: pnpm --filter @botiverse/raft-shared generate:agent-api-description
// Freshness:  pnpm --filter @botiverse/raft-shared check:agent-api-description-fresh

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildAgentApiDescription } from "../src/agentApiDescription";

const outFile = resolve(import.meta.dirname, "../agent-api/agent-api.v1.json");

writeFileSync(outFile, `${JSON.stringify(buildAgentApiDescription(), null, 2)}\n`);
