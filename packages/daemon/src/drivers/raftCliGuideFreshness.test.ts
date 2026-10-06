/**
 * Freshness guard for the generated `manual/agent-knowledge/raft-cli-overview.md`.
 *
 * This test replaced `.github/workflows/check-slock-cli-guide.yml` (@xxchan
 * 2026-08-31): the committed manual topic is a generated artifact of
 * `buildRaftCliOverviewMdx()`, and the two must stay byte-identical. Living in
 * the daemon suite means it runs on every PR (unit-daemon is deliberately
 * unfiltered — see the task #50 note in test.yml), so drift from either side —
 * a builder edit without regeneration, or a hand-edit of the committed file —
 * goes red without a dedicated workflow or its rot-prone path filter.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildRaftCliOverviewMdx } from "./raftCliGuide";

const TEST_DIR = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(TEST_DIR, "..", "..", "..", "..");
const COMMITTED_PATH = resolve(REPO_ROOT, "manual", "agent-knowledge", "raft-cli-overview.md");

test("committed raft-cli-overview manual topic matches the canonical builder byte-for-byte", () => {
  const committed = readFileSync(COMMITTED_PATH, "utf-8");
  const generated = buildRaftCliOverviewMdx();
  assert.equal(
    committed,
    generated,
    [
      "manual/agent-knowledge/raft-cli-overview.md is out of date.",
      "",
      "It is a generated artifact of packages/shared/src/raftCliGuide.ts.",
      "Do not hand-edit the .md — edit the builder and regenerate:",
      "",
      "  pnpm --filter @botiverse/raft-daemon generate:raft-cli-guide",
      "  git add manual/agent-knowledge/raft-cli-overview.md",
    ].join("\n"),
  );
});

test("the daemon renders the guide with the same shared builder the server's /context uses", async () => {
  // One source of truth: `GET /internal/agent-api/context` renders
  // `buildRaftCliGuideMarkdown(identity)` from @botiverse/raft-shared, and the
  // daemon's guide module must be that exact function, not a copy.
  const shared = await import("@botiverse/raft-shared");
  const daemon = await import("./raftCliGuide");
  assert.equal(daemon.buildRaftCliGuideMarkdown, shared.buildRaftCliGuideMarkdown);
  assert.equal(daemon.buildRaftCliGuideSections, shared.buildRaftCliGuideSections);

  const identity = { handle: "alice", displayName: "Alice", description: "Reviewer", serverName: "Acme" };
  const rendered = daemon.buildRaftCliGuideMarkdown(identity);
  assert.match(rendered, /You are "Alice" \(@alice\), an external AI agent in the Raft server "Acme"/);
  assert.doesNotMatch(rendered, /<your-handle>|<your-display-name>/);
  // Apart from the identity it is the manual's self-hosted render.
  const placeholder = daemon.buildRaftCliGuideMarkdown();
  const strip = (text: string) => text.replace(/^(Replace the literal placeholders|You are "|Initial role:).*$/gm, "")
    .replaceAll("<your-handle>", "alice").replaceAll("<your-display-name>", "Alice")
    .replace(/\n{3,}/g, "\n\n");
  assert.equal(strip(rendered), strip(placeholder));
});
