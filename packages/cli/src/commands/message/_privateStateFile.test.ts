// Security-audit contract for the CLI's local message state, carried onto the
// agent ledger (RFC 072 R1): state lives in a user-private directory, is
// never reached through a symlink, and pre-hardening layouts are imported
// once — the world-readable tmpdir copy is removed, the private-layout copy
// is kept for rollback.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSavedDraft, setSavedDraft } from "./_continueDraftState";
import { recordConsumedSeqs, getConsumedSeq } from "./_consumedSeqState";

for (const kind of ["draft", "cursor"] as const) test(`${kind} state is private and never follows symlinks`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-cli-state-"));
  const env = kind === "draft" ? "SLOCK_CLI_DRAFT_STATE_DIR" : "SLOCK_CLI_CONSUMED_SEQ_STATE_DIR";
  const old = process.env[env]; process.env[env] = root;
  const agentId = `audit-${process.pid}-${kind}`;
  const dir = path.join(root, "slock-cli-ledger", agentId);
  const file = path.join(dir, "state.db");
  const write = () => kind === "draft" ? setSavedDraft(agentId, "dm:@peer", { content: "private draft", attachmentIds: [], savedAt: Date.now(), reholdCount: 0 }) : recordConsumedSeqs(agentId, { "dm:@peer": 7 });
  const read = () => kind === "draft" ? getSavedDraft(agentId, "dm:@peer")?.content : getConsumedSeq(agentId, "dm:@peer");
  try {
    write();
    assert.equal(read(), kind === "draft" ? "private draft" : 7);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
      // A symlink planted at the database path must fail closed: no write
      // through the link, no read from it, victim bytes untouched. A draft
      // write fails loudly (the caller must not report "draft saved");
      // cursor bookkeeping stays best-effort.
      const writeRefused = () => { if (kind === "draft") assert.throws(write); else write(); };
      const victim = path.join(root, "victim"); fs.writeFileSync(victim, "must survive");
      fs.rmSync(dir, { recursive: true }); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.symlinkSync(victim, file);
      writeRefused();
      assert.equal(fs.readFileSync(victim, "utf8"), "must survive");
      assert.ok(read() === undefined || read() === null, "reads through a planted link fail closed");
      // A symlink planted at the ledger directory is refused the same way.
      fs.rmSync(dir, { recursive: true }); fs.symlinkSync(root, dir);
      writeRefused();
      assert.ok(read() === undefined || read() === null);
      assert.equal(fs.existsSync(path.join(root, "state.db")), false, "the redirected directory gains no state file");
    }
  } finally { if (old === undefined) delete process.env[env]; else process.env[env] = old; fs.rmSync(root, { recursive: true, force: true }); }
});

for (const kind of ["draft", "cursor"] as const) test(`${kind} state written by the pre-hardening layouts is imported once on first read`, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "audit-cli-home-"));
  const agentId = `legacy-import-${process.pid}-${kind}`;
  const namespace = kind === "draft" ? "slock-cli-attested-send" : "slock-cli-consumed-seq";
  const filename = kind === "draft" ? "continue-state.json" : "consumed-seqs.json";
  const legacyDir = path.join(os.tmpdir(), namespace, agentId);
  const legacyFile = path.join(legacyDir, filename);
  const env = kind === "draft" ? "SLOCK_CLI_DRAFT_STATE_DIR" : "SLOCK_CLI_CONSUMED_SEQ_STATE_DIR";
  const saved = { override: process.env[env], home: process.env.RAFT_HOME, slockHome: process.env.SLOCK_HOME };
  delete process.env[env]; delete process.env.SLOCK_HOME; process.env.RAFT_HOME = home;
  const legacyContent = kind === "draft"
    ? JSON.stringify({ targets: { "dm:@peer": { content: "draft from before the upgrade", attachmentIds: [], savedAt: Date.now(), reholdCount: 0 } } })
    : JSON.stringify({ targets: { "dm:@peer": { seq: 41, readOrder: 1 } }, nextReadOrder: 2 });
  const read = () => kind === "draft" ? getSavedDraft(agentId, "dm:@peer")?.content : getConsumedSeq(agentId, "dm:@peer");
  try {
    // The oldest layout: shared tmpdir, default (group/other readable) mode.
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(legacyFile, legacyContent, { mode: 0o644 });
    assert.equal(read(), kind === "draft" ? "draft from before the upgrade" : 41, "state saved before the upgrade must still be readable");
    const dbFile = path.join(home, "agent-state", agentId, "state.db");
    assert.equal(fs.existsSync(dbFile), true, "the import lands in the agent ledger");
    if (process.platform !== "win32") assert.equal(fs.statSync(dbFile).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(legacyFile), false, "the world-readable copy is removed after import");
    // A later legacy file never overrides the ledger.
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(legacyFile, legacyContent.replace("41", "99").replace("before the upgrade", "stale"), { mode: 0o644 });
    assert.equal(read(), kind === "draft" ? "draft from before the upgrade" : 41);
  } finally {
    fs.rmSync(legacyDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    if (saved.override === undefined) delete process.env[env]; else process.env[env] = saved.override;
    if (saved.home === undefined) delete process.env.RAFT_HOME; else process.env.RAFT_HOME = saved.home;
    if (saved.slockHome !== undefined) process.env.SLOCK_HOME = saved.slockHome;
  }
});

test("the hardened private-layout store is imported in preference to the shared tmpdir and left in place", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "audit-cli-home-"));
  const agentId = `legacy-private-${process.pid}`;
  const legacyDir = path.join(os.tmpdir(), "slock-cli-consumed-seq", agentId);
  const legacyFile = path.join(legacyDir, "consumed-seqs.json");
  const privateDir = path.join(home, "slock-cli-consumed-seq", agentId);
  const privateFile = path.join(privateDir, "consumed-seqs.json");
  const saved = { override: process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR, home: process.env.RAFT_HOME, slockHome: process.env.SLOCK_HOME };
  delete process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR; delete process.env.SLOCK_HOME; process.env.RAFT_HOME = home;
  try {
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(legacyFile, JSON.stringify({ targets: { "dm:@peer": { seq: 11, readOrder: 1 } }, nextReadOrder: 2 }), { mode: 0o644 });
    fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(privateFile, JSON.stringify({ targets: { "dm:@peer": { seq: 52, readOrder: 3 } }, nextReadOrder: 4 }), { mode: 0o600 });
    assert.equal(getConsumedSeq(agentId, "dm:@peer"), 52, "the private layout is the newer store and wins");
    assert.equal(fs.existsSync(privateFile), true, "the private copy is kept for rollback");
  } finally {
    fs.rmSync(legacyDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    if (saved.override === undefined) delete process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR; else process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = saved.override;
    if (saved.home === undefined) delete process.env.RAFT_HOME; else process.env.RAFT_HOME = saved.home;
    if (saved.slockHome !== undefined) process.env.SLOCK_HOME = saved.slockHome;
  }
});

test("legacy import refuses symlinks and does not run under an explicit state directory", () => {
  if (process.platform === "win32") return;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "audit-cli-home-"));
  const agentId = `legacy-symlink-${process.pid}`;
  const legacyDir = path.join(os.tmpdir(), "slock-cli-attested-send", agentId);
  const legacyFile = path.join(legacyDir, "continue-state.json");
  const planted = path.join(home, "planted.json");
  const saved = { override: process.env.SLOCK_CLI_DRAFT_STATE_DIR, home: process.env.RAFT_HOME, slockHome: process.env.SLOCK_HOME };
  delete process.env.SLOCK_CLI_DRAFT_STATE_DIR; delete process.env.SLOCK_HOME; process.env.RAFT_HOME = home;
  try {
    fs.writeFileSync(planted, JSON.stringify({ targets: { "dm:@peer": { content: "planted", attachmentIds: [], savedAt: Date.now(), reholdCount: 0 } } }));
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.symlinkSync(planted, legacyFile);
    assert.equal(getSavedDraft(agentId, "dm:@peer"), null, "a symlink at the legacy path is not imported");
    assert.equal(fs.lstatSync(legacyFile).isSymbolicLink(), true, "the symlink is left untouched");

    fs.unlinkSync(legacyFile);
    fs.writeFileSync(legacyFile, JSON.stringify({ targets: { "dm:@peer": { content: "legacy", attachmentIds: [], savedAt: Date.now(), reholdCount: 0 } } }), { mode: 0o644 });
    const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-cli-override-"));
    process.env.SLOCK_CLI_DRAFT_STATE_DIR = overrideDir;
    try {
      assert.equal(getSavedDraft(agentId, "dm:@peer"), null, "an explicit state directory has no legacy location to import from");
      assert.equal(fs.existsSync(legacyFile), true);
    } finally {
      fs.rmSync(overrideDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(legacyDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    if (saved.override === undefined) delete process.env.SLOCK_CLI_DRAFT_STATE_DIR; else process.env.SLOCK_CLI_DRAFT_STATE_DIR = saved.override;
    if (saved.home === undefined) delete process.env.RAFT_HOME; else process.env.RAFT_HOME = saved.home;
    if (saved.slockHome !== undefined) process.env.SLOCK_HOME = saved.slockHome;
  }
});
