// Context generation signal (RFC 072 §7.2): which model context an agent's
// CLI is currently running in.
//
// The daemon writes `$SLOCK_CLI_TRANSPORT_DIR/<CONTEXT_GENERATION_FILENAME>`
// before each runtime spawn and again at every `compaction_started`. A
// compaction or a fresh spawn gets a new opaque `contextId`; resuming a
// runtime session keeps the id that session last had (a resume is not a new
// context, per tygg in #proj-aiax:915fd5fa). The CLI treats "seen" as valid
// only while the `contextId` it recorded still matches.
//
// The path is not resolved here: the transport directory is already computed
// by the daemon and injected into the agent process as SLOCK_CLI_TRANSPORT_DIR,
// so this module only names the file and its shape.

export const CONTEXT_GENERATION_FILENAME = "context-generation";

/** Upper bound the CLI enforces when reading the file (RFC 072 §7.2.2). */
export const CONTEXT_GENERATION_MAX_BYTES = 4096;

/** `resume` reuses the id the resumed session last had; the others are new. */
export type ContextGenerationReason = "spawn" | "resume" | "compaction";

export interface ContextGenerationRecord {
  /** Opaque id; compare for equality only, never order. */
  contextId: string;
  reason: ContextGenerationReason;
  /**
   * Whether this runtime reports context compaction. When false, an unchanged
   * `contextId` does NOT mean the context was kept: the CLI must not treat it
   * as proof of "seen" across time (RFC 072 §7.2.4).
   */
  compactionReported: boolean;
  runtime: string;
  writtenAt: string;
  /**
   * Feature gate for passive AX (task #359): the Server flag `passive_ax`
   * combined on the daemon with its `RAFT_PASSIVE_AX` kill switch. Carried in
   * this daemon-written file, not the runtime environment, so an agent cannot
   * switch it off for a single command. Readers treat a missing field (an
   * older daemon) as false.
   */
  passiveAx: boolean;
}
