import assert from "node:assert/strict";
import { resolveAgentKnowledgeDoc } from "./agentKnowledgeService";

// The page said a non-member mention in a private channel or DM is "rejected
// on send: Mention target @… is not visible in this channel". That error no
// longer exists in the server source (staging or prod): private/joint scope
// resolves a non-member to nobody, and DM scope resolves same-server handles as
// inert facts that are never notified. A DM send mentioning four
// non-participants went through and produced pending rows (#proj-task 8ce4c9ba).
// DM rows carry no action because notify/add exist only for channels/threads.
test("mention doc no longer claims non-member mentions are rejected on send", async () => {
  const doc = await resolveAgentKnowledgeDoc("mention");
  assert.ok(doc, "the topic must resolve");

  assert.doesNotMatch(doc.content, /is not visible in this channel/,
    "the retired rejection error must not come back");
  assert.doesNotMatch(doc.content, /non-member is rejected on send/,
    "no send is rejected for a non-member mention");
  assert.match(doc.content, /Nothing is rejected on send in either case\./,
    "the no-rejection fact must be stated");
  assert.match(doc.content, /In a \*\*DM\*\*, a handle for someone on the same server who is not in the DM resolves, but they are never notified\./,
    "the DM half must be stated separately from the private-channel half");
  assert.match(doc.content, /A listed row is not necessarily actionable\./,
    "listed pending rows must not read as resolvable");
});

// Both non-member outcomes print `not_queued`, but only one is recoverable
// (Cat's review of #8009): public channel = `not_in_conversation` with a
// notify/add action; private channel = `unknown_or_not_visible`, no recovery.
test("mention doc distinguishes the two not_queued reasons", async () => {
  const doc = await resolveAgentKnowledgeDoc("mention");
  assert.ok(doc, "the topic must resolve");
  assert.match(doc.content, /reason `not_in_conversation`, and the mention becomes a sender-side \*\*notify\/add\*\* action/);
  assert.match(doc.content, /reason `unknown_or_not_visible`, the same as a typo\)\. No pending entry is created and there is no recovery command\./);
});
