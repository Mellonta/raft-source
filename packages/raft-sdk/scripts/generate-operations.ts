// The operation manifest as JSON, for gateways that are not TypeScript:
// shipped as `@botiverse/raft-sdk/operations.json`, generated from the same
// definitions as `RAFT_OPERATIONS` (src/operations.ts). Never edit it by hand.
//
// Regenerate: pnpm --filter @botiverse/raft-sdk generate:operations
// Freshness:  src/operations.test.ts fails when the committed file is stale.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildRaftOperationsDocument } from "../src/operations";

const outFile = resolve(import.meta.dirname, "../operations.json");

writeFileSync(outFile, `${JSON.stringify(buildRaftOperationsDocument(), null, 2)}\n`);
