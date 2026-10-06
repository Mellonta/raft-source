import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveAgentKnowledgeDoc } from "./agentKnowledgeService";

// #8227 corrected a false claim on two agent-facing pages: `raft server info` was
// documented as listing every channel, when it returns counts only and
// `raft server info --channels` returns ONE PAGE (50) of what this server has 190 of.
// The corrected text quotes the CLI's own paging footer, `Showing 1-50 of N`, and
// tells the agent the `--offset` command continues it.
//
// @Cat asked for this guard when #8227 landed, for the reason a quoted literal
// always needs one: the page asserts what another package prints. Reword the CLI
// and the page goes stale with nothing turning red — the page's own test would
// still pass, because it only checks that the page contains the sentence it
// contains. So bind the two together.
//
// A red here does NOT mean the CLI is wrong. It means the quoted text and the
// emitting source have diverged, and a human must decide which side to move.
//
// EVIDENCE CLASS: source-to-source agreement at the current revision. This is NOT
// a measurement of what a deployed CLI prints, and nothing here may be cited as one:
// the pages are served with the server build, the CLI ships with Raft Computer, and
// an agent on an older carrier can read the new page while running the old printer.

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
// xxchan's Phase 3a refactor moved the server/channel/user/thread/profile
// text formatters verbatim from packages/cli/src/commands/*/_format.ts into
// shared agentText; the CLI now delegates to them. The template the pages
// quote therefore lives in the shared module, and the CLI-side risk changes
// shape: not "did the CLI reword its template" but "did the CLI stop
// delegating and re-inline a divergent one". Pin both ends of that.
const SHARED_SERVER_TEXT = join(REPO_ROOT, "packages", "shared", "src", "agentText", "server.ts");
const CLI_FORMAT = join(REPO_ROOT, "packages", "cli", "src", "commands", "server", "_format.ts");
const CLI_INFO = join(REPO_ROOT, "packages", "cli", "src", "commands", "server", "info.ts");

const QUOTED_FOOTER = /Showing 1-50 of N/;
const PAGED_TOPICS = ["channel", "raft-cli-overview"] as const;

test("[quoted-literal] both pages quote the paging footer rather than describing it", async () => {
  for (const topic of PAGED_TOPICS) {
    const resolved = await resolveAgentKnowledgeDoc(topic);
    assert.ok(resolved, `the ${topic} topic must resolve`);
    assert.match(resolved.content, QUOTED_FOOTER,
      `${topic} must quote the footer an agent actually sees, not paraphrase it`);
    assert.match(resolved.content, /--channels/,
      `${topic} must name the flag that does the listing`);
    assert.match(resolved.content, /--offset/,
      `${topic} must name the flag that continues the listing`);
  }
});

test("[lockstep-footer] the quoted footer traces to the source that prints it", () => {
  const shared = readFileSync(SHARED_SERVER_TEXT, "utf-8");
  // The literal the pages quote is a placeholder form of this template. Pin the
  // template, not a rendered sample: a rendered sample would need real numbers and
  // would pass while the words around them changed. Since the Phase 3a refactor
  // the template's authority is shared agentText (packages/shared/src/agentText/
  // server.ts); the CLI delegates to it.
  assert.ok(
    shared.includes("Showing ${start}-${end} of ${page.total}"),
    "packages/shared/src/agentText/server.ts no longer prints "
    + "`Showing <start>-<end> of <total>`; the pages quoting `Showing 1-50 of N` are now stale",
  );
});

test("[lockstep-footer-delegation] the CLI still delegates to the shared formatter instead of re-inlining one", () => {
  const cliFormat = readFileSync(CLI_FORMAT, "utf-8");
  // If someone re-inlines a divergent template into the CLI instead of
  // delegating to shared agentText, the two printers drift again — and this
  // goes red. The delegation itself is the contract.
  assert.ok(
    cliFormat.includes("formatAgentServerChannels("),
    "packages/cli/src/commands/server/_format.ts no longer delegates to shared "
    + "formatAgentServerChannels; check whether a divergent template was re-inlined",
  );
});

test("[lockstep-offset] the continuation command the pages promise is built with --offset", () => {
  const info = readFileSync(CLI_INFO, "utf-8");
  assert.ok(
    info.includes("--offset ${nextOffset}"),
    "packages/cli/src/commands/server/info.ts no longer builds the next page with `--offset`; "
    + "the pages telling agents to use `--offset` for the rest are now stale",
  );
  // The promise is conditional in source: no continuation exists on the last page.
  // Pinned so a page can never be corrected into promising it unconditionally.
  assert.ok(
    info.includes("if (nextOffset >= total) return undefined"),
    "the next-command builder no longer withholds a continuation on the last page; "
    + "any page that says the footer always offers one would become wrong",
  );
});
