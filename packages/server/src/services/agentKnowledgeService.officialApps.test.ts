import assert from "node:assert/strict";
import { resolveAgentKnowledgeDoc } from "./agentKnowledgeService";

// Contract rev3.1 §4b (task #302): the served `integration` page must teach the
// platform-set `official` mark and `purpose`, say the list is installed-only,
// and no longer carry the absolute "does not auto-install" phrasing that the
// platform-default pre-install made false.
test("integration page serves the official-app contract (rev3.1 §4b)", async () => {
  const doc = await resolveAgentKnowledgeDoc("integration");
  assert.ok(doc, "integration must resolve");
  const body = doc.content;
  for (const must of [
    "official: yes (set by the platform, never by the app)",
    "one-line `purpose`",
    "an app cannot declare itself official",
    "never lists an official app that is not installed on this Server",
    "login never installs the App by itself",
  ]) {
    assert.ok(body.includes(must), `integration page must contain: ${must}`);
  }
  for (const retired of ["it does not auto-install", "never auto-installed", "never auto-installs"]) {
    assert.ok(!body.includes(retired), `integration page must not contain: ${retired}`);
  }
});
