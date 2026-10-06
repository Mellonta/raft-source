import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveAgentKnowledgeDoc } from "./agentKnowledgeService";

// Guards the inbox page against the claim it carried until this test landed:
// "`raft message check` — pulls all pending inbox messages, marks them as
// drained" / "Returns the messages so the agent can decide what to act on".
//
// Read at staging 0477aafef, that is false in a way that matters. In
// `registerAgentApiRoute("events")` (packages/server/src/routes/internalAgentApi.ts)
// every queued message is run through `canAgentAccessQueuedMessageTarget`
// first; the ones that fail go to `undeliverableQueued` and straight into
// `agentOrchestrator.discardUndeliverableMessages` — drained, never returned.
// The predicate fails on a deleted channel, a channel on another server, an
// agent that is no longer a delivery recipient, and on ANY thrown error
// (`catch { return false }`). `has_more` is `filtered.length > trimmed.length`
// over the DELIVERABLE list, so nothing in the response marks the drop.
//
// Why this is a docs defect and not a nit: an agent that believes a completed
// `check` drained "all pending" will read a missing item as one it already
// handled. The page must state the gap at the point of the claim, not later.
//
// EVIDENCE CLASS: code contract at a named revision. It is NOT a field
// measurement of the discard path on this deployment — that reading is not in
// this test and must not be claimed from it.

const CANON_WARNING = /Drained is not the same as returned/;
const CANON_DISCARD = /discarded \*?unreturned\*?/;
const CANON_NOT_PROOF = /a `check` that completes is not proof you saw everything that was queued/;

test("[canonical] inbox states that a drain can discard without returning", async () => {
  const resolved = await resolveAgentKnowledgeDoc("inbox");
  assert.ok(resolved, "the topic must resolve");

  assert.match(resolved.content, CANON_WARNING,
    "the drained-vs-returned distinction must be stated, not left to inference");
  assert.match(resolved.content, CANON_DISCARD,
    "it must say the dropped messages are never handed to the agent");
  assert.match(resolved.content, CANON_NOT_PROOF,
    "it must deny the inference an agent actually makes: completed check ⇒ saw everything");

  // Anti-regression on the exact retracted wording. "all pending" is the word
  // that licenses the wrong inference; "pulls ... marks them as drained" is
  // what made pulled and drained look like one set.
  assert.doesNotMatch(resolved.content, /pulls all pending inbox messages/,
    "must not promise that check pulls all pending messages");
  assert.doesNotMatch(resolved.content, /Each call drains current pending and returns\./,
    "the streaming bullet must not restate the same false equivalence");
});

test("[placement] the warning sits in the agent-action section, beside the command", async () => {
  const resolved = await resolveAgentKnowledgeDoc("inbox");
  assert.ok(resolved, "the topic must resolve");

  const start = resolved.content.indexOf("## What agents do");
  const next = resolved.content.indexOf("\n## ", start + 1);
  assert.ok(start >= 0, "the agent-action section must exist");
  assert.ok(next > start, "a following section must bound it");
  const section = resolved.content.slice(start, next);

  // A qualifier one section away is already lost: the agent decides what to do
  // about a missing message while it is reading the drain command.
  assert.match(section, CANON_WARNING,
    "the warning must sit with `raft message check`, not only in Gotchas");
  assert.match(section, /raft message check/,
    "sanity: this is the section that carries the command");
});

test("[multi-cause] the didn't-see-this gotcha does not offer a single cause", async () => {
  const resolved = await resolveAgentKnowledgeDoc("inbox");
  assert.ok(resolved, "the topic must resolve");

  const line = resolved.content
    .split("\n")
    .find((l) => l.includes("My agent didn't see this message"));
  assert.ok(line, "the gotcha must exist");

  // Both causes on the same line. A reader who stops at the first explanation
  // gets the wrong one roughly whenever the first one does not apply.
  // Matches both "may not have been called recently" and "has not been called
  // recently": this clause is not what the fix changes, so the guard must not
  // pin my rewording of it — only that the cause is still there.
  assert.match(line, /been called recently/,
    "the common cause (no check this turn) must stay");
  assert.match(line, /undeliverable|discarded/,
    "the discard cause must ride on the same line as the common one");
  assert.match(line, /does not establish/,
    "it must name the invalid inference, not just add a cause");
});

// The page now quotes a literal that lives in another package. @Cat asked for it
// (#proj-docs:0581d8f0) for a good reason: an agent can act on the sentence it
// actually sees, not on `has_more`. But a quoted literal is frozen text with a
// clock — change the CLI string and the page goes stale with nothing turning red.
// So bind them. `drainComplete` in packages/cli/src/commands/message/_inbox.ts is
// `!hasMore && allMessages.length > 0`, which is why the all-discarded case prints
// neither status line; that is the second claim pinned here.
const CLI_CHECK = join(
  import.meta.dirname, "..", "..", "..", "..",
  "packages", "cli", "src", "commands", "message", "check.ts",
);

test("[lockstep] the status lines the page quotes are the ones the CLI prints", async () => {
  const resolved = await resolveAgentKnowledgeDoc("inbox");
  assert.ok(resolved, "the topic must resolve");
  const cli = readFileSync(CLI_CHECK, "utf-8");

  for (const literal of [
    "No more new inbox messages.",
    "More messages are pending.",
  ]) {
    assert.ok(cli.includes(literal),
      `the CLI no longer prints "${literal}" — the inbox page quotes it and must be updated`);
  }
  assert.match(resolved.content, /No more new inbox messages\./,
    "the page must quote the closing line an agent actually reads");
  assert.match(resolved.content, /prints \*\*no status line at all\*\*/,
    "the all-discarded case must stay named: zero returned ⇒ neither status line");
});
