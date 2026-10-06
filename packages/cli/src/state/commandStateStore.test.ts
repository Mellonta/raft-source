// The CLI's ledger-backed CommandStateStore answers exactly like shared's
// reference in-memory store for the same sequence of operations.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { test } from "vitest";
import {
  ConsumedSeqLedger,
  createMemoryCommandStateStore,
  expectSync,
  type CommandStateStore,
} from "@botiverse/raft-shared/src/agentOps/seenPolicy/index";

import { createCliCommandStateStore } from "./commandStateStore";

function scenario(store: CommandStateStore, setContext: (contextId: string | null) => void): unknown[] {
  const ledger = new ConsumedSeqLedger(store);
  const seen: unknown[] = [];
  const snap = () => {
    seen.push({
      general: expectSync(store.readStreamEntry("#general")),
      all: expectSync(store.readAllStreamEntries()),
      exactGeneral: expectSync(store.readExactSeqsWithContext("#general")),
      exactDm: expectSync(store.readExactSeqsWithContext("dm:@bob")),
      resolved: expectSync(store.resolveCanonicalTarget("#General")),
    });
  };
  expectSync(ledger.recordTargetAlias("#General", "#general"));
  expectSync(ledger.recordConsumedExactSeqs({ "#General": [9, 7, 12] }));
  snap();
  expectSync(ledger.recordConsumedRead("#General", 8));
  snap();
  expectSync(ledger.recordConsumedRead("#general"));
  expectSync(ledger.recordConsumedSeqs({ "dm:@bob": 4, "#general:abcdef12": 2 }));
  expectSync(ledger.recordConsumedExactSeqs({ "dm:@bob": [3, 6] }));
  snap();
  setContext("ctx-A");
  expectSync(ledger.recordConsumedExactSeqs({ "dm:@bob": [8] }));
  expectSync(ledger.recordConsumedRead("#general", 5));
  snap();
  seen.push(expectSync(ledger.getConsumedSeq("dm:@bob")), expectSync(ledger.wasEvidenceWithheldForContext("dm:@bob")));
  seen.push(expectSync(ledger.getMostRecentConsumedThreadForParent("#general")));
  expectSync(store.writeDraft("#general", { content: "x", attachmentIds: [], savedAt: 5, reholdCount: 0, idempotencyKey: "k" }));
  seen.push(expectSync(store.readDraft("#general")));
  seen.push(expectSync(store.deleteDraftIfSavedAt("#general", 4)), expectSync(store.deleteDraftIfIdempotencyKeyMatches("#general", "k")));
  seen.push(expectSync(store.readDraft("#general")));
  return seen;
}

test("the ledger store matches the reference memory store", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-state-store-"));
  const transportDir = path.join(root, "transport");
  fs.mkdirSync(transportDir, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = { SLOCK_CLI_STATE_DIR: path.join(root, "state"), RAFT_HOME: path.join(root, "home") };
  const cliStore = createCliCommandStateStore("agent-store-parity", env);
  const memoryStore = createMemoryCommandStateStore();

  const fromCli = scenario(cliStore, (contextId) => {
    assert.ok(contextId);
    fs.writeFileSync(
      path.join(transportDir, "context-generation"),
      JSON.stringify({ contextId, reason: "spawn", compactionReported: true, runtime: "claude", writtenAt: "t", passiveAx: true }),
      { mode: 0o600 },
    );
    env.SLOCK_CLI_TRANSPORT_DIR = transportDir;
  });
  const fromMemory = scenario(memoryStore, (contextId) => memoryStore.setContextId(contextId));

  assert.deepEqual(fromCli, fromMemory);
  // The scenario exercises real records, not empty answers on both sides.
  assert.deepEqual((fromMemory[1] as { general: unknown }).general, { seq: 8, readOrder: 1 });
  assert.deepEqual((fromMemory[3] as { exactDm: unknown }).exactDm, { seqs: [8], contextId: "ctx-A" });
  assert.equal(fromMemory[4], undefined);
  assert.equal(fromMemory[5], true);
});
