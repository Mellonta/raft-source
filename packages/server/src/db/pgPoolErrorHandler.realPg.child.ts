// Child entry for pgPoolErrorHandler.realPg.test.ts (task #269).
//
// This process must exercise the REAL production wiring — createPool from
// db/index.ts, which runs attachPoolClientErrorHandler — never a mirror of
// it, so that deleting the helper body or the wiring turns case B red. It is
// launched with the repo's own TS loader:
//   node --import @oxc-node/core/register src/db/pgPoolErrorHandler.realPg.child.ts
import { createPool } from "./index";

const url = process.env.PG_POOL_ERROR_HANDLER_REAL_PG_URL;
if (!url) throw new Error("PG_POOL_ERROR_HANDLER_REAL_PG_URL is required");

const pool = createPool(url);
const client = await pool.connect();
// PoolClient does not expose processID in its public type; it is present at
// runtime (same access pattern as cancelPgQuery in db/index.ts).
const backendPid = (client as unknown as { processID?: number }).processID;
if (backendPid == null) throw new Error("checked-out client has no processID");
console.log("BACKEND_PID", backendPid);
// Held between queries and never released — the exact prod crash window.
setInterval(() => {}, 1000);
