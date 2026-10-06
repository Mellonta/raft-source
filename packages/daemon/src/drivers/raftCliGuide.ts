// The Raft CLI operating guide lives in `@botiverse/raft-shared`
// (`packages/shared/src/raftCliGuide.ts`) so the daemon's managed-runner
// system prompt, the generated `raft-cli-overview` manual topic, and the
// server's `GET /internal/agent-api/context` (external agents) all render from
// one source. This module re-exports it for daemon-local imports.
export {
  MESSAGE_HEREDOC_DELIMITER,
  OFFICIAL_APPS_HINT,
  OFFICIAL_APPS_HINT_VERSION,
  buildMentionsSection,
  buildRaftCliGuideMarkdown,
  buildInstalledAppDirectory,
  buildRaftCliGuideSections,
  buildRaftCliOverviewMdx,
  type BuildRaftCliGuideSectionsOptions,
  type MentionsIdentity,
  type RaftCliGuideAudience,
  type InstalledAppDirectoryEntry,
  type RaftCliGuideSections,
  type RaftCliGuideShell,
  type SelfHostedAgentGuideIdentity,
} from "@botiverse/raft-shared";
