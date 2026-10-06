import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildStatusReport, runStatus } from "./status";
import { servicePidPath, serverConnectedMarkerPath } from "./paths";
import { markFatalConfig, markTerminalUnlinked } from "./health";
import { DEFAULT_SLOCK_SERVER_URL, LEGACY_PRODUCTION_SERVER_URL } from "./serverUrl";
import { COMPUTER_VERSION } from "./version";

// task #30 PR-G regression guard — Computer-level aggregate `status`.
// Pins: fresh state, per-server aggregation, daemon liveness from
// per-server pidfile, service liveness, and the SECRET REDLINE
// (the report must never carry user access token or any sk_computer_*).

const SERVER_A = "11111111-1111-4111-8111-111111111111";
const SERVER_B = "22222222-2222-4222-8222-222222222222";
const SECRET_TOKEN = "user-access-token-DO-NOT-LEAK-abc123";
const SECRET_KEY_A = "sk_computer_AAA-DO-NOT-LEAK-aaaaaaaaaaaa";
const SECRET_KEY_B = "sk_computer_BBB-DO-NOT-LEAK-bbbbbbbbbbbb";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-status-"));
  const old = process.env.SLOCK_HOME;
  process.env.SLOCK_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (old === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = old;
    await rm(home, { recursive: true, force: true });
  }
}

async function writeUnder(home: string, rel: string, body: string): Promise<void> {
  const p = join(home, "computer", rel);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, body);
}

async function writeAttach(home: string, serverId: string, apiKey: string, url = "https://api.example.test"): Promise<void> {
  await writeUnder(
    home,
    `servers/${serverId}/runner.state.json`,
    JSON.stringify({
      kind: "computer-attachment",
      serverId,
      serverMachineId: `cm-${serverId}`,
      apiKey,
      serverUrl: url,
      attachedAt: "2026-05-20T00:00:00.000Z",
    }),
  );
}

test("status: fresh home → not logged in, service stopped, no attachments", async () => {
  await withHome(async (home) => {
    const r = await buildStatusReport(home);
    assert.equal(r.slockHome, home);
    assert.equal(r.cliVersion, COMPUTER_VERSION);
    assert.equal(r.loggedIn, false);
    assert.equal(r.userId, null);
    assert.equal(r.service.running, false);
    assert.equal(r.service.version.version, null);
    assert.equal(r.service.logPath, join(home, "computer", "run", "service.log"));
    assert.deepEqual(r.servers, []);
  });
});

test("status: user session present → loggedIn; tokens NEVER carried in report", async () => {
  await withHome(async (home) => {
    await writeUnder(home, "user-session.json", JSON.stringify({
      kind: "user-session",
      userId: "user-42",
      accessToken: SECRET_TOKEN,
      refreshToken: "refresh-secret",
      serverUrl: "https://api.example.test",
    }));
    const r = await buildStatusReport(home);
    assert.equal(r.loggedIn, true);
    assert.equal(r.userId, "user-42");
    assert.equal(r.loginServerUrl, "https://api.example.test");
    const blob = JSON.stringify(r);
    assert.ok(!blob.includes(SECRET_TOKEN), "leaked accessToken");
    assert.ok(!blob.includes("refresh-secret"), "leaked refreshToken");
  });
});

test("status: legacy production URLs are displayed as the canonical Raft API URL", async () => {
  await withHome(async (home) => {
    await writeUnder(home, "user-session.json", JSON.stringify({
      kind: "user-session",
      userId: "user-42",
      accessToken: SECRET_TOKEN,
      serverUrl: LEGACY_PRODUCTION_SERVER_URL,
    }));
    await writeAttach(home, SERVER_A, SECRET_KEY_A, LEGACY_PRODUCTION_SERVER_URL);

    const r = await buildStatusReport(home);
    assert.equal(r.loginServerUrl, DEFAULT_SLOCK_SERVER_URL);
    assert.equal(r.servers[0]?.serverUrl, DEFAULT_SLOCK_SERVER_URL);
  });
});

test("status: surfaces the session's display identity (task #112: name/displayName/email)", async () => {
  await withHome(async (home) => {
    await writeUnder(home, "user-session.json", JSON.stringify({
      kind: "user-session",
      userId: "user-42",
      accessToken: SECRET_TOKEN,
      serverUrl: "https://api.example.test",
      name: "cindy zhao",
      displayName: "Cindy",
      email: "cindy@example.io",
    }));
    const r = await buildStatusReport(home);
    assert.equal(r.userName, "cindy zhao");
    assert.equal(r.userDisplayName, "Cindy");
    assert.equal(r.userEmail, "cindy@example.io");
  });
});

test("status: older session without display identity → name/displayName/email null (fallback path)", async () => {
  await withHome(async (home) => {
    await writeUnder(home, "user-session.json", JSON.stringify({
      kind: "user-session",
      userId: "user-42",
      accessToken: SECRET_TOKEN,
      serverUrl: "https://api.example.test",
    }));
    const r = await buildStatusReport(home);
    assert.equal(r.userName, null);
    assert.equal(r.userDisplayName, null);
    assert.equal(r.userEmail, null);
  });
});

test("status: corrupted user-session.json is explicit and secret-free", async () => {
  await withHome(async (home) => {
    await writeUnder(home, "user-session.json", '{"kind":"user-session","userId":"abc","acce');
    const r = await buildStatusReport(home);
    assert.equal(r.loggedIn, false);
    assert.equal(r.userId, null);
    assert.equal(r.loginServerUrl, null);
    assert.match(r.userSessionError ?? "", /JSON/);

    const lines: string[] = [];
    const oldWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runStatus();
    } finally {
      process.stdout.write = oldWrite;
    }
    const out = lines.join("");
    assert.match(out, /user session file is invalid/);
    assert.match(out, /raft-computer login/);
    assert.ok(!out.includes("abc"), "human output should not echo corrupted session content");
  });
});

test("status: multiple attachments → servers[] aggregates; sk_computer_* NEVER in report", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, SECRET_KEY_A);
    await writeAttach(home, SERVER_B, SECRET_KEY_B);
    const r = await buildStatusReport(home);
    assert.equal(r.servers.length, 2);
    const ids = r.servers.map((s) => s.serverId).sort();
    assert.deepEqual(ids, [SERVER_A, SERVER_B]);
    for (const s of r.servers) {
      assert.equal(s.daemon.running, false);
      assert.equal(s.serverRunnerLogPath, join(home, "computer", "servers", s.serverId, "runner.log"));
    }
    const blob = JSON.stringify(r);
    assert.ok(!blob.includes(SECRET_KEY_A), "leaked sk_computer_* (A)");
    assert.ok(!blob.includes(SECRET_KEY_B), "leaked sk_computer_* (B)");
  });
});

test("status: JSON report includes derived log paths", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, SECRET_KEY_A);
    const r = JSON.parse(JSON.stringify(await buildStatusReport(home)));
    assert.equal(r.service.logPath, join(home, "computer", "run", "service.log"));
    assert.equal(
      r.servers[0].serverRunnerLogPath,
      join(home, "computer", "servers", SERVER_A, "runner.log"),
    );
  });
});

test("status: human output prints service and per-server server-runner log paths", async () => {
  await withHome(async (home) => {
    await writeUnder(home, "user-session.json", JSON.stringify({
      kind: "user-session",
      userId: "user-42",
      accessToken: SECRET_TOKEN,
      refreshToken: "refresh-secret",
      serverUrl: "https://api.example.test",
    }));
    await writeUnder(
      home,
      `servers/${SERVER_A}/runner.state.json`,
      JSON.stringify({
        kind: "computer-attachment",
        serverId: SERVER_A,
        serverSlug: "alpha",
        serverMachineId: `cm-${SERVER_A}`,
        apiKey: SECRET_KEY_A,
        serverUrl: "https://api.example.test",
        attachedAt: "2026-05-20T00:00:00.000Z",
      }),
    );

    const lines: string[] = [];
    const oldWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runStatus();
    } finally {
      process.stdout.write = oldWrite;
    }

    const out = lines.join("");
    assert.match(out, new RegExp(`Service log: ${join(home, "computer", "run", "service\\.log")}`));
    assert.match(out, /\/alpha\s+offline\s+no\s+stopped/);
    assert.match(
      out,
      new RegExp(`Server runner log: ${join(home, "computer", "servers", SERVER_A, "runner\\.log")}`),
    );
    assert.ok(!out.includes(SECRET_TOKEN), "human output leaked accessToken");
    assert.ok(!out.includes(SECRET_KEY_A), "human output leaked sk_computer_*");
  });
});

test("status: live pidfiles → service + per-server server-runner report running", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, SECRET_KEY_A);
    await writeUnder(home, "run/service.pid", String(process.pid));
    await writeUnder(home, `servers/${SERVER_A}/runner.pid`, String(process.pid));
    const r = await buildStatusReport(home);
    assert.equal(r.service.running, true);
    assert.equal(r.service.running === true && r.service.pid, process.pid);
    const sa = r.servers.find((s) => s.serverId === SERVER_A);
    assert.ok(sa);
    assert.equal(sa?.daemon.running, true);
  });
});

test("status: live service and runner version evidence are surfaced separately", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, SECRET_KEY_A);
    await writeUnder(home, "run/service.pid", String(process.pid));
    await writeUnder(home, "service-version.json", JSON.stringify({
      version: "0.0.73",
      installRoot: "/old/service",
      pid: process.pid,
      writtenAt: "2026-07-06T00:00:00.000Z",
    }));
    await writeUnder(home, `servers/${SERVER_A}/runner.pid`, String(process.pid));
    await writeUnder(home, `servers/${SERVER_A}/runner-version.json`, JSON.stringify({
      version: "0.0.74",
      installRoot: "/new/runner",
      pid: process.pid,
      writtenAt: "2026-07-06T00:00:01.000Z",
    }));

    const r = await buildStatusReport(home);
    assert.equal(r.service.version.version, "0.0.73");
    assert.equal(r.service.version.evidencePid, process.pid);
    const sa = r.servers.find((s) => s.serverId === SERVER_A);
    assert.equal(sa?.runnerVersion.version, "0.0.74");
    assert.equal(sa?.runnerVersion.evidencePid, process.pid);
  });
});

test("status: stale version evidence is not reported as live", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, SECRET_KEY_A);
    await writeUnder(home, "run/service.pid", String(process.pid));
    await writeUnder(home, "service-version.json", JSON.stringify({
      version: "0.0.1",
      installRoot: "/stale",
      pid: 999999999,
      writtenAt: "2026-07-06T00:00:00.000Z",
    }));
    await writeUnder(home, `servers/${SERVER_A}/runner.pid`, String(process.pid));
    await writeUnder(home, `servers/${SERVER_A}/runner-version.json`, JSON.stringify({
      version: "0.0.1",
      installRoot: "/stale",
      pid: 999999999,
      writtenAt: "2026-07-06T00:00:01.000Z",
    }));

    const r = await buildStatusReport(home);
    assert.equal(r.service.version.version, null);
    const sa = r.servers.find((s) => s.serverId === SERVER_A);
    assert.equal(sa?.runnerVersion.version, null);
  });
});

test("status: legacy server-runner pid/log remain visible during version-split window", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, SECRET_KEY_A);
    await writeUnder(home, "run/service.pid", String(process.pid));
    await writeUnder(home, `servers/${SERVER_A}/server-runner.pid`, String(process.pid));
    await writeUnder(home, `servers/${SERVER_A}/server-runner.log`, "legacy runner log\n");
    const r = await buildStatusReport(home);
    const sa = r.servers.find((s) => s.serverId === SERVER_A);
    assert.ok(sa);
    assert.equal(sa?.daemon.running, true);
    assert.equal(
      sa?.serverRunnerLogPath,
      join(home, "computer", "servers", SERVER_A, "server-runner.log"),
    );
  });
});

test("status: malformed runner.state.json → that server is skipped; others OK", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, SECRET_KEY_A);
    await writeUnder(home, `servers/${SERVER_B}/runner.state.json`, "{ not json");
    const r = await buildStatusReport(home);
    assert.deepEqual(r.servers.map((s) => s.serverId), [SERVER_A]);
  });
});

// `deriveHealth` order regression. crash-budget-tripped runners are parked
// by the supervisor — they have NO live pid. Earlier the order checked
// liveness first, so a degraded-and-parked runner came back as `offline`,
// hiding the fact that it needs explicit retry to recover. Honest tray icons +
// glance-and-fix UX both depend on judging `degraded` first.
test("status: degraded runner with no live pid → health=degraded, NOT offline", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, SECRET_KEY_A);
    // Trip the degraded marker (fatalConfig forces isDegraded=true regardless
    // of crash budget). Don't write a runner.pid → daemon.running=false.
    await markFatalConfig(home, SERVER_A, 78, null);
    const r = await buildStatusReport(home);
    const sa = r.servers.find((s) => s.serverId === SERVER_A);
    assert.ok(sa);
    assert.equal(sa?.daemon.running, false);
    assert.equal(sa?.health, "degraded", "degraded must win over no-pid-offline");
  });
});

test("status: terminal unlinked marker → health=unlinked, not generic disconnected", async () => {
  await withHome(async (home) => {
    await writeUnder(
      home,
      `servers/${SERVER_A}/runner.state.json`,
      JSON.stringify({
        kind: "computer-attachment",
        serverId: SERVER_A,
        serverSlug: "alpha",
        serverMachineId: `cm-${SERVER_A}`,
        apiKey: SECRET_KEY_A,
        serverUrl: "https://api.example.test",
        attachedAt: "2026-05-20T00:00:00.000Z",
      }),
    );
    await writeUnder(home, `servers/${SERVER_A}/runner.pid`, String(process.pid));
    await markTerminalUnlinked(home, SERVER_A, `cm-${SERVER_A}`, 401);
    const r = await buildStatusReport(home);
    const sa = r.servers.find((s) => s.serverId === SERVER_A);
    assert.ok(sa);
    assert.equal(sa.daemon.running, true);
    assert.equal(sa.serverConnected, false);
    assert.equal(sa.health, "unlinked");

    const lines: string[] = [];
    const oldWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runStatus();
    } finally {
      process.stdout.write = oldWrite;
    }
    const out = lines.join("");
    assert.match(out, /\/alpha\s+unlinked\s+no\s+running \(pid \d+\)/);
    assert.match(out, /server deleted\/unlinked this Computer or machine/);
    assert.match(out, /raft-computer setup \/<serverSlug>/);
    assert.match(out, /raft-computer status \/<serverSlug>/);
    assert.doesNotMatch(out, /back up|move the stale/i);
  });
});

test("status: not degraded + no live pid → health=offline (cold attachment)", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, SECRET_KEY_A);
    // No degraded marker, no runner.pid — the cold-attachment / service-
    // not-managing case stays `offline`.
    const r = await buildStatusReport(home);
    const sa = r.servers.find((s) => s.serverId === SERVER_A);
    assert.equal(sa?.health, "offline");
  });
});

test("status: no connected marker → serverConnected=false", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, SECRET_KEY_A);
    await writeUnder(home, `servers/${SERVER_A}/runner.pid`, String(process.pid));
    const r = await buildStatusReport(home);
    const sa = r.servers.find((s) => s.serverId === SERVER_A);
    assert.equal(sa?.serverConnected, false);
  });
});

test("status: connected marker + live pid → serverConnected=true", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, SECRET_KEY_A);
    await writeUnder(home, `servers/${SERVER_A}/runner.pid`, String(process.pid));
    await writeUnder(home, `servers/${SERVER_A}/runner.connected`, String(Date.now()));
    const r = await buildStatusReport(home);
    const sa = r.servers.find((s) => s.serverId === SERVER_A);
    assert.equal(sa?.serverConnected, true);
  });
});

test("status: stale connected marker + dead pid → serverConnected=false", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, SECRET_KEY_A);
    // Marker exists but no live runner.pid — runner crashed without cleanup.
    await writeUnder(home, `servers/${SERVER_A}/runner.connected`, String(Date.now()));
    const r = await buildStatusReport(home);
    const sa = r.servers.find((s) => s.serverId === SERVER_A);
    assert.equal(sa?.daemon.running, false);
    assert.equal(sa?.serverConnected, false, "stale marker with dead process must not report connected");
  });
});
