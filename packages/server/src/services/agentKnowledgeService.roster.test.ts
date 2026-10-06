import assert from "node:assert/strict";
import { resolveAgentKnowledgeDoc, searchAgentKnowledgeDocs } from "./agentKnowledgeService";

// meichen's reason digests 2026-09-16/17: "people directory" recurred as a natural
// search miss on two Agents. The roster question is answered by the membership
// page; this tooth binds that the page is reachable by the natural phrasings and
// teaches `raft user info`.
test("roster phrasings surface the membership page first", async () => {
  for (const query of ["people directory", "who is in this server"]) {
    const results = await searchAgentKnowledgeDocs(query);
    assert.ok(results.length > 0, `${query} must return results`);
    assert.equal(results[0]?.slug, "membership", `${query} must rank membership first, got ${results[0]?.slug}`);
  }
});

test("membership page teaches raft user info for one member", async () => {
  const doc = await resolveAgentKnowledgeDoc("membership");
  assert.ok(doc);
  assert.ok(doc.content.includes("`raft user info <name>`"));
  assert.ok(doc.content.includes("the member list you can see is the directory"));
  assert.ok(doc.content.includes("not found or not visible to you"));
  assert.ok(doc.content.includes("`raft server info --humans`"));
  assert.ok(!doc.content.includes("list all members"), "the bare server info claim must stay retired");
});
