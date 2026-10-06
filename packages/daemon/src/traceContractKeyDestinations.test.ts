import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BasicTracer } from "@botiverse/raft-shared";
import { LocalRotatingTraceSink } from "@botiverse/raft-trace-client";
import { DAEMON_CORE_TRACE_ATTR_CONTRACTS } from "./core";

// Task #424. A span contract that lists an ID-shaped key is making a promise;
// the local sink decides whether that promise can be kept. Until now nothing
// compared the two, so a contract could name a key the sink silently drops —
// which is exactly the #422 defect, one layer up.
//
// The predicate is NOT "every contract key is in the sink allowlist" (@Leiysky).
// It is "every contract key HAS A DESTINATION", of which there are three, each
// with its own evidence:
//
//   1. LANDS   — the key itself is written to disk.
//   2. CARRIED — the key is transformed, and a stand-in lands instead
//                (session_id -> session_id_hash, or a *_present flag).
//   3. ABSENT  — nothing is emitted under that name at all, deliberately.
//
// Only "none of the three" is a failure.
//
// ⚠️ Class 3 is the false-green, and it is why this file reads the emit sites
// rather than trusting the disk. "Not on disk" is ALSO what a silent sink drop
// looks like, so an absence proves nothing on its own: it has to be pinned to
// the place the emit was removed. Every ABSENT entry below therefore carries a
// reason naming that place, and `assertEmitSiteIsGone` re-checks it against the
// tree WITH a positive control (@Leiysky), because a zero from a grep can also
// mean the grep was pointed at the wrong surface — which is a mistake I made on
// this very key earlier in #422.

type Destination =
  | { kind: "lands" }
  | { kind: "carried"; by: string }
  | { kind: "absent"; emitRemovedAt: string; controlKey: string };

/**
 * Keys a contract lists that are deliberately never emitted. Each names where
 * the emit went, so a later reader can check the claim instead of inheriting it.
 */
const ABSENT: Record<string, Extract<Destination, { kind: "absent" }>> = {
  // #460 ruled the fact id off the readable surface; #422 then removed the emit
  // itself, because leaving it made every daemon span pay a dropped-attribute
  // count for a value that could never land.
  producer_fact_id: {
    kind: "absent",
    emitRemovedAt: "packages/daemon/src/connection.ts (daemon.agent.activity.sent)",
    // Emitted on the SAME span and still present, so a zero for the key above
    // cannot be an artefact of grepping the wrong file.
    controlKey: "daemon_instance_id_present",
  },
};

/**
 * Contract keys that are knowingly emitted-and-dropped, pending a per-key
 * ruling. EMPTY is the correct state; an entry is a declared, owned hold.
 *
 * Compared BY NAME in both directions, not by count (@Stone). Counting lets a
 * resolved exemption (−1) and a brand-new divergence (+1) cancel out, so the new
 * one hides inside the old one's allowance. The two directions catch different
 * things:
 *
 *   dropped − exempt  => a NEW divergence appeared.
 *   exempt − dropped  => an exemption OUTLIVED its cause and nobody deleted it.
 *
 * The second is the one worth having: "if this is still here and nobody
 * remembers why, that is the bug" is a sentence with no enforcement point, and
 * this turns it into one — a stale entry fails the build rather than waiting to
 * be noticed (@Leiysky).
 *
 * Format: key -> why it is accepted, and who must rule to remove it.
 */
const DIVERGENCE_PENDING_RULING: Record<string, string> = {};

/** Stand-ins: the contract names the left key, the sink writes the right one. */
const CARRIERS: Record<string, string> = {
  session_id: "session_id_hash",
  sessionId: "session_id_hash",
  runtime_session_id: "runtime_session_id_present",
};

function idShaped(key: string): boolean {
  const snake = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return /(^|_)id$/.test(snake);
}

interface SpanContract {
  spanAttrs?: readonly string[];
  endAttrs?: readonly string[];
  eventAttrs?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Every attribute name a span contract declares, across ALL THREE of its lists.
 *
 * A span's record is not one set of attributes: start, end and each event carry
 * their own. Reading only `spanAttrs` was not "one list left to iterate" — it
 * was the word "contract" meaning something narrower here than in the rule it
 * was checking (@Leiysky), which is why walking one list looked complete.
 *
 * `eventAttrs` is nested INSIDE the span contract, so the span a key belongs to
 * is the outer key and there is no lookup that can fail (@Stone verified). If
 * events are ever hoisted into a standalone map — say to share definitions
 * across spans — that stops being true, and "cannot determine the span" would
 * need its own branch, distinct from "passes". That distinction does not exist
 * in the CURRENT SHAPE; it is not a distinction that cannot exist.
 */
function declaredAttrs(contract: SpanContract): string[] {
  return [
    ...(contract.spanAttrs ?? []),
    ...(contract.endAttrs ?? []),
    ...Object.values(contract.eventAttrs ?? {}).flat(),
  ];
}

function contractIdKeys(): string[] {
  const keys = new Set<string>();
  for (const contract of Object.values(DAEMON_CORE_TRACE_ATTR_CONTRACTS)) {
    for (const key of declaredAttrs(contract as SpanContract)) {
      if (idShaped(key)) keys.add(key);
    }
  }
  return [...keys].sort();
}

/** Writes one span carrying every key, and returns what actually reached disk. */
async function whatLandsOnDisk(keys: readonly string[]): Promise<{ written: Record<string, unknown>; machineDir: string; droppedTotal: number; droppedNameList: string[]; droppedNamesCapped: boolean }> {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-424-"));
  const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 4 });
  const tracer = new BasicTracer({ sink });
  const attrs: Record<string, unknown> = {};
  // A `*_present` flag is a boolean by contract; writing a string there would
  // make the carrier assertion below compare the wrong type and fail for a
  // reason that has nothing to do with the sink.
  for (const key of keys) attrs[key] = key.endsWith("_present") ? true : `v-${key}`;
  tracer.startSpan("daemon.contract.probe", { surface: "daemon", kind: "internal", attrs: attrs as never }).end("ok");

  let written: Record<string, unknown> = {};
  for (const name of readdirSync(path.join(machineDir, "traces"))) {
    const text = await readFile(path.join(machineDir, "traces", name), "utf8");
    for (const line of text.split("\n").filter((l) => l.length > 0)) {
      const record = JSON.parse(line) as { name?: string; attrs?: Record<string, unknown> };
      if (record.name === "daemon.contract.probe") written = record.attrs ?? {};
    }
  }
  // `windowNames` is name -> count; `windowByReason` is reason -> count. Either
  // sums to the window total, so use the by-reason one and report the names.
  const report = sink.drainSinkReport().attrDrops;
  const droppedTotal = Object.values(report.windowByReason).reduce((a, b) => a + b, 0);
  // `windowNamesFull` is TRUE when the name table hit its cap, i.e. the list is a
  // SAMPLE — the flag reads like "the list is complete", and it is the opposite.
  // I had this backwards first, which put "list is a sample" on a single-name
  // report: a diagnostic that states the reverse of what happened.
  const droppedNameList = Object.keys(report.windowNames).sort();
  return { written, machineDir, droppedTotal, droppedNameList, droppedNamesCapped: report.windowNamesFull };
}

test("#424 every ID-shaped key in a daemon span contract has a destination", async () => {
  const keys = contractIdKeys();
  assert.ok(keys.length > 0, "positive control: the contracts must yield ID-shaped keys at all");

  // The carriers must be in the probe too: a stand-in only lands if the producer
  // emitted it, and most carriers are not themselves ID-shaped, so they are not
  // in `keys`. Without this every carried key looks homeless.
  const { written, machineDir, droppedNameList, droppedNamesCapped } = await whatLandsOnDisk([...keys, ...Object.values(CARRIERS)]);
  try {
    const homeless: string[] = [];
    for (const key of keys) {
      if (key in written) continue;                                  // 1. lands
      const carrier = CARRIERS[key];
      if (carrier && carrier in written) continue;                   // 2. carried
      if (ABSENT[key]) continue;                                     // 3. absent
      homeless.push(key);
    }
    assert.deepEqual(
      homeless,
      [],
      `these contract keys have no destination — the contract promises them and the sink drops them, ` +
        `with nothing standing in and no recorded reason: ${homeless.join(", ")}`,
    );

    // A second set of teeth, on a different failure mode (@Leiysky). "Emitted,
    // then dropped" is not a stable state — the #8649 counter sees every drop —
    // so if any contract key took that path the count is non-zero even when the
    // assertion above is satisfied. The two cannot mask each other: the one
    // above says a key has nowhere to go, this one says a key went somewhere and
    // was thrown away en route.
    // A capped name table means the list is a SAMPLE, so neither direction below
    // can be trusted. Fail outright rather than compare against a partial set.
    assert.equal(droppedNamesCapped, false, "the dropped-name table hit its cap; the comparison below would be run against a sample");

    const exempt = Object.keys(DIVERGENCE_PENDING_RULING).sort();
    const newDivergences = droppedNameList.filter((name) => !(name in DIVERGENCE_PENDING_RULING));
    assert.deepEqual(
      newDivergences,
      [],
      `a contract key was emitted and then dropped by the sink: ${newDivergences.join(", ")}. ` +
        `The contract and the allowlist have diverged: either allow the key, give it a declared ` +
        `carrier, or take it off the contract — do not leave it paying a drop on every span.`,
    );

    const staleExemptions = exempt.filter((name) => !droppedNameList.includes(name));
    assert.deepEqual(
      staleExemptions,
      [],
      `these divergences are no longer happening, but their exemptions are still listed: ` +
        `${staleExemptions.join(", ")}. The ruling landed and the entry outlived it — delete it, ` +
        `or the next real divergence with that name is silently pre-approved.`,
    );
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#424 the probe itself can fail — a key with no destination is detected", async () => {
  // Without this, a bug that made every key look landed would read as a pass.
  const { written, machineDir } = await whatLandsOnDisk(["definitely_dropped_id", "agent_id"]);
  try {
    assert.ok(!("definitely_dropped_id" in written), "an unlisted id must be dropped by the sink");
    assert.equal(written.agent_id, "v-agent_id", "…while an allowed one lands, so the probe discriminates");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#424 the carriers named above really are what the sink writes", async () => {
  const { written, machineDir } = await whatLandsOnDisk(["session_id", "runtime_session_id", "runtime_session_id_present"]);
  try {
    assert.ok(!("session_id" in written), "precondition: the raw session id never lands");
    assert.equal(typeof written.session_id_hash, "string", "session_id is carried by its hash");
    assert.ok(!("runtime_session_id" in written), "precondition: the raw runtime session id never lands");
    assert.equal(
      written.runtime_session_id_present,
      true,
      "runtime_session_id is carried by its presence flag (#422 class B: no other carrier exists)",
    );
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

// @Leiysky's "allowed per app" is a CONJUNCTION, and the sink can only satisfy
// half of it. The sink is span-blind: once a name is on the global allowlist it
// lands on ANY span. So the allowlist gives "the value is constrained by some
// app's normalizer" but NOT "this key only ever appears on that app's spans" —
// and `source_id` / `item_id` are generic enough that someone will eventually
// put free text in one on an unrelated span (@Stone). The second half is only
// expressible here, at the contract level, which is why this is part of the
// determination rather than an optional hardening.
const APP_FAMILY_ONLY_KEYS = ["app_id", "owner_agent_id", "source_id", "item_id", "app_correlation_id"] as const;

function isAppFamilySpan(name: string): boolean {
  return name.startsWith("daemon.app_") || name === "daemon.agent.app_inbox_notice";
}

test("#424 the app-family keys appear only on app-family spans", () => {
  const offenders: string[] = [];
  let appFamilySpansSeen = 0;
  for (const [span, contract] of Object.entries(DAEMON_CORE_TRACE_ATTR_CONTRACTS)) {
    const attrs = declaredAttrs(contract as SpanContract);
    if (isAppFamilySpan(span)) {
      appFamilySpansSeen += 1;
      continue;
    }
    for (const key of APP_FAMILY_ONLY_KEYS) {
      if (attrs.includes(key)) offenders.push(`${key} on ${span}`);
    }
  }

  // Forward assertion, so this cannot be satisfied by DELETING the app spans
  // (@Stone). An "only on X" rule is vacuously true when there is no X, and a
  // vacuous pass looks exactly like a real one.
  assert.ok(
    appFamilySpansSeen > 0,
    "no app-family span is left in the contracts — this rule would pass vacuously",
  );

  assert.deepEqual(
    offenders,
    [],
    `an app-family key is used outside the app family: ${offenders.join(", ")}. ` +
      `These keys are allowed on the readable surface PER APP, which means two things at once: ` +
      `the value is constrained by that app's normalizer, AND the key appears only on that app's ` +
      `spans. The sink cannot enforce the second (it does not know which span it is writing), so ` +
      `it is enforced here. If the new use is legitimate, it needs its own determination.`,
  );
});
