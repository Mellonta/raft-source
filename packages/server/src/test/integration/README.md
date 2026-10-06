# Server integration tests

Use Vitest fixtures to remove per-case migrations, login setup, and cleanup
boilerplate. Every case gets a fresh PGlite restored from a file-local migrated
template. Commits and inner transaction rollbacks remain real.

```ts
import assert from "node:assert/strict";
import { apiTest } from "../test/integration/apiTest.js";

apiTest("lists the channel the reader can access", async ({ seed, http }) => {
  const reader = await seed.human();
  const server = await seed.server({ owner: reader });
  const channel = await seed.channel({ server, members: [reader] });
  const response = await http.as(reader, server).get("/api/channels");
  assert.equal(response.status, 200);
  const rows = await response.json() as Array<{ id: string }>;
  assert.ok(rows.some(row => row.id === channel.id));
});
```

- `dbTest` supplies `db`, `seed`, and `lifecycle`; `apiTest` also supplies `app`
  and `http`. Unused fixtures do not start a DB or import the app.
- Keep production defaults. For an intentional flag/configuration variant use
  `createApiTest({ onboardingOpenerFlagDefaultEnabled: false })`. Vitest 2 binds
  fixture dependencies at extension time, so do not override `appOptions` later.
- `http.as` and `tokenForHuman` issue real access tokens and run production auth.
  Tests of login, session families, refresh, or revocation must use real login.
  `fixturePasswordHash` caches only immutable fixture hashes, never auth results.
- Seed only preconditions. Call production code for the operation under test;
  include valid-access and unaffected-record witnesses in denial/filter tests.
- Register extra resources with `lifecycle.own(async () => stopAndJoinWork())`.
  Cleanup stops HTTP, drains registered DB work, then closes DB. Cleanup failures
  fail the case; a poisoned environment refuses further cases. Restore custom
  dependency overrides and environment variables in the test's own `finally`.
- Use `test.skipIf` and file parallelism. Vitest 2's runtime `context.skip()` skips
  teardown, so integration fixtures reject it; concurrent cases share a DB module
  and are rejected. Existing runner, worker, shard, and watchdog policy is retained.
- Loops, suite hooks, custom app options, and Playwright can use `openTestApp` /
  `openTestDatabase` with explicit `try/finally`. Close before opening another DB.
  Migration tests and real-Postgres contracts keep the production initializer.

## Choose PGlite or real PostgreSQL by contract

PGlite is the default for ordinary integration behavior, but it is not an
oracle for PostgreSQL wire-protocol limits. In particular, bind-parameter
boundary tests must run against real PostgreSQL:

- PostgreSQL accepts at most 65,535 bound parameters in one statement and
  rejects an over-limit bind with SQLSTATE `08P01`.
- PGlite reaches a different 32,767-parameter boundary and has been observed to
  fail silently beyond it. A passing or non-throwing PGlite result therefore
  cannot prove production behavior at either boundary.
- Put large fan-out, bulk `VALUES`, large `IN (...)`, and parameter-chunking
  boundary teeth in a `*.realPg.test.ts` contract backed by a hosted PostgreSQL
  service. Make CI set both the test URL and a `*_REQUIRED=1` guard so a missing
  database fails the job instead of turning the contract into a skip.
- PGlite remains useful for behavior comfortably below these limits. If a test
  asks what PostgreSQL accepts, rejects, or reports at the bind boundary, only
  the real-PostgreSQL result is authoritative.

Run existing shard commands. `RAFT_TEST_PROFILE=1` adds per-case elapsed time,
DB/app/seed/cleanup timings and process memory. `cleanup` contains the close
subphases; do not add overlapping phases. Use `lifecycle.measure("operation", fn)`
for an explicit operation measurement. File-local templates rebuild each run.
