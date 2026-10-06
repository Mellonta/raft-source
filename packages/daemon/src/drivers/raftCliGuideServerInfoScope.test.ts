/**
 * Guards the one claim this file exists to stop: that `raft server info` shows
 * you all the channels.
 *
 * Measured on a live seat 2026-09-24:
 *   raft server info            -> "Channels: 189 visible (27 joined)" and a list
 *                                  of narrow queries. Lists ZERO channels.
 *   raft server info --channels -> 50 rows, then "Showing 1-50 of 189." plus
 *                                  "More: raft server info --channels --offset 50 --limit 50"
 *
 * The CLI is honest — it prints the total and the next command. The defect was
 * purely textual, and it sat on four surfaces: this builder, the generated
 * manual topic, the generated systemPrompt snapshot, and the hand-written
 * `manual/agent-knowledge/channel.md`. Three of those four are generated from
 * this builder, which is why this guard binds the builder and the hand-written
 * page and lets the freshness/snapshot tests carry the generated pair.
 *
 * Why it is worth a guard rather than just a fix: an agent told one call shows
 * "all channels" either reads the summary as a failed query, or takes a 50-row
 * window as the population and then makes an absence claim over 189 channels.
 * The second failure is silent.
 *
 * ⚠️ SCOPE OF PROTECTION — do not overstate this file. `unit-daemon` does NOT
 * run on ordinary pull requests: its `if:` requires `startsWith(github.head_ref,
 * 'stamp-mq/')`, and it was observed `skipping` on PR #8195. The comment above
 * that `if:` ("Run the package-owned suite on every PR") and this suite's own
 * freshness-test header ("it runs on every PR") both overstate the coverage.
 * So this guard protects staging pushes and the merge queue, ⛔ not an ordinary
 * PR. Pre-merge, it needs `gh workflow run test.yml --ref <branch>`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildRaftCliOverviewMdx } from "./raftCliGuide";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..", "..");
const CHANNEL_PAGE = resolve(REPO_ROOT, "manual", "agent-knowledge", "channel.md");

// Bound to the CLAIM, not to one sentence: any surface telling an agent that
// plain `server info` yields all/every channel is the defect, however worded.
const TOTALITY_CLAIM = /`raft server info`[^.\n]{0,80}\b(?:all|every)\b[^.\n]{0,40}channels/i;

for (const [name, read] of [
  ["raft-cli-overview builder", () => buildRaftCliOverviewMdx()],
  ["channel.md", () => readFileSync(CHANNEL_PAGE, "utf-8")],
] as const) {
  test(`[no-totality] ${name} does not say plain \`raft server info\` lists all channels`, () => {
    const text = read();
    assert.doesNotMatch(text, TOTALITY_CLAIM,
      "plain `raft server info` lists no channels at all — it returns counts and points at --channels");
  });

  test(`[pagination-inline] ${name} names --channels and says it pages`, () => {
    const text = read();
    assert.match(text, /`raft server info --channels`/,
      "the command that actually lists channels must be named");
    // The qualifier has to ride inside the claim: a reader who stops at "this
    // lists the channels" must already have been told it is one page of N.
    assert.match(text, /Showing 1-50 of|paged|\bpages\b/,
      "the page marker the CLI prints must appear where the listing command is introduced");
    assert.match(text, /--offset/,
      "the way to get the remaining pages must be named, not left to --help");
  });
}
