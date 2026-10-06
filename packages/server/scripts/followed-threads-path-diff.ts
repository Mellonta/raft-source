#!/usr/bin/env -S node --import=@oxc-node/core/register
/**
 * Read-only comparison of GET /api/channels/threads/followed's two paths for one
 * (server, user): the active-follows RisingWave path (rw_followed_threads_v5)
 * and the legacy all-Postgres list (forceLegacyPath), both with the server
 * plan's history cutoff, exactly as the route calls getFollowedThreads.
 *
 * Prints the timings, row counts, the RW path's partition counts and a
 * per-field diff keyed by threadChannelId (order is not compared: rows with the
 * same lastActivityAt may tie differently). Exits 1 on any difference, 2 when
 * the RW path did not actually serve from RisingWave (e.g. the view is missing),
 * since that run compares legacy with legacy.
 *
 * Usage:
 *   DATABASE_URL=... RISINGWAVE_DATABASE_URL=... pnpm --filter @botiverse/raft-server \
 *     followed-threads:path-diff -- --server-id <uuid> --user-id <uuid> [--legacy-first] [--max-diffs 50]
 */
import { BasicTracer, MemoryTraceSink, type TraceAttributes } from "@botiverse/raft-shared";
import { closeDatabase, initDatabase } from "../src/db/index";
import { closeRisingWavePool } from "../src/db/risingwave";
import { getFollowedThreads } from "../src/services/channelService";
import { getHistoryCutoff, getServerPlan } from "../src/services/planService";
import { createTraceDbQueryTracer, withTraceRoot } from "../src/tracing/semanticTrace";

type Options = { serverId: string; userId: string; legacyFirst: boolean; maxDiffs: number };
type FollowedThread = Awaited<ReturnType<typeof getFollowedThreads>>[number];
type PathRun = {
  threads: FollowedThread[];
  durationMs: number;
  source: TraceAttributes | undefined;
  queries: Array<{ name: string; durationMs: number }>;
};

function usage(): string {
  return "Usage: followed-threads-path-diff.ts --server-id <uuid> --user-id <uuid> [--legacy-first] [--max-diffs 50]";
}

function parseArgs(argv: string[]): Options {
  const options: Partial<Options> = { legacyFirst: false, maxDiffs: 50 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--server-id" && argv[i + 1]) options.serverId = argv[++i];
    else if (arg === "--user-id" && argv[i + 1]) options.userId = argv[++i];
    else if (arg === "--legacy-first") options.legacyFirst = true;
    else if (arg === "--max-diffs" && argv[i + 1]) options.maxDiffs = Math.max(Number(argv[++i]) || 0, 0);
    else throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }
  if (!options.serverId || !options.userId) throw new Error(usage());
  return options as Options;
}

async function runPath(options: Options, historyCutoff: Date | undefined, forceLegacyPath: boolean): Promise<PathRun> {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const started = performance.now();
  const threads = await withTraceRoot(
    tracer,
    "script.followed_threads_path_diff",
    { surface: "server" },
    () => getFollowedThreads(options.serverId, options.userId, historyCutoff, {
      traceQuery: createTraceDbQueryTracer("followed_threads.loaded"),
      forceLegacyPath,
    }),
  );
  const durationMs = Math.round(performance.now() - started);
  const events = sink.getAllSpans().flatMap((span) => span.events);
  return {
    threads,
    durationMs,
    source: events.find((event) => event.name === "followed_threads.source_selected")?.attrs,
    queries: events
      .filter((event) => event.name === "db.query.finished")
      .map((event) => ({ name: String(event.attrs?.query_name), durationMs: Number(event.attrs?.duration_ms ?? 0) })),
  };
}

function diffThreads(rw: FollowedThread[], legacy: FollowedThread[]) {
  const rwById = new Map(rw.map((thread) => [thread.threadChannelId, thread]));
  const legacyById = new Map(legacy.map((thread) => [thread.threadChannelId, thread]));
  const onlyInRw = [...rwById.keys()].filter((id) => !legacyById.has(id));
  const onlyInLegacy = [...legacyById.keys()].filter((id) => !rwById.has(id));
  const fieldDiffs: Array<{ threadChannelId: string; field: string; rw: unknown; legacy: unknown }> = [];
  const fieldDiffCounts: Record<string, number> = {};
  for (const [id, rwThread] of rwById) {
    const legacyThread = legacyById.get(id);
    if (!legacyThread) continue;
    const fields = new Set([...Object.keys(rwThread), ...Object.keys(legacyThread)]);
    for (const field of fields) {
      const rwValue = (rwThread as Record<string, unknown>)[field];
      const legacyValue = (legacyThread as Record<string, unknown>)[field];
      if (JSON.stringify(rwValue) === JSON.stringify(legacyValue)) continue;
      fieldDiffs.push({ threadChannelId: id, field, rw: rwValue, legacy: legacyValue });
      fieldDiffCounts[field] = (fieldDiffCounts[field] ?? 0) + 1;
    }
  }
  return { onlyInRw, onlyInLegacy, fieldDiffs, fieldDiffCounts };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!process.env.RISINGWAVE_DATABASE_URL) throw new Error("RISINGWAVE_DATABASE_URL is required");
  await initDatabase(databaseUrl, undefined, { log: () => {} });
  try {
    const plan = await getServerPlan(options.serverId);
    const historyCutoff = getHistoryCutoff(plan);
    let rw: PathRun;
    let legacy: PathRun;
    if (options.legacyFirst) {
      legacy = await runPath(options, historyCutoff, true);
      rw = await runPath(options, historyCutoff, false);
    } else {
      rw = await runPath(options, historyCutoff, false);
      legacy = await runPath(options, historyCutoff, true);
    }
    const diff = diffThreads(rw.threads, legacy.threads);
    const rwServed = rw.source?.followed_threads_source === "rw_v5";
    const identical = diff.onlyInRw.length === 0 && diff.onlyInLegacy.length === 0 && diff.fieldDiffs.length === 0;
    console.log(JSON.stringify({
      ok: rwServed && identical,
      serverId: options.serverId,
      userId: options.userId,
      plan,
      historyCutoff: historyCutoff?.toISOString() ?? null,
      order: options.legacyFirst ? "legacy_first" : "rw_first",
      rw: {
        durationMs: rw.durationMs,
        threads: rw.threads.length,
        unreadThreads: rw.threads.filter((thread) => thread.unreadCount > 0).length,
        source: rw.source,
        queries: rw.queries,
      },
      legacy: {
        durationMs: legacy.durationMs,
        threads: legacy.threads.length,
        unreadThreads: legacy.threads.filter((thread) => thread.unreadCount > 0).length,
        source: legacy.source,
        queries: legacy.queries,
      },
      diff: {
        onlyInRw: diff.onlyInRw,
        onlyInLegacy: diff.onlyInLegacy,
        fieldDiffCounts: diff.fieldDiffCounts,
        fieldDiffsTotal: diff.fieldDiffs.length,
        fieldDiffs: diff.fieldDiffs.slice(0, options.maxDiffs),
      },
    }, null, 2));
    if (!rwServed) {
      console.error(`RW path did not serve from RisingWave (source: ${JSON.stringify(rw.source)}); nothing was compared.`);
      process.exitCode = 2;
    } else if (!identical) {
      process.exitCode = 1;
    }
  } finally {
    await closeRisingWavePool();
    await closeDatabase();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
