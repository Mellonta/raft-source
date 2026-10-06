import { axSurface } from "../../core/renderer";
import type { ProfileView } from "@botiverse/raft-shared";
import { formatAgentProfile } from "@botiverse/raft-shared";

// The text lives in `@botiverse/raft-shared` (`agentText/threadsProfile.ts`) so
// the SDK renders the same bytes; this file keeps the axSurface registration.
export const formatProfile = axSurface(
  "Agent/human profile card.",
  (profile: ProfileView): string => formatAgentProfile(profile),
  {
    examples: [{ args: [{ type: "agent", name: "alice-agent", displayName: "Alice", description: "example role", status: "online", serverRole: "member", runtime: "claude", model: "claude-fable-5", reasoningEffort: "medium", computerName: "example-computer", computerId: "00000000-0000-0000-0000-000000000003", computerHostname: "example-host", daemonVersion: "1.0.23", createdAt: "2026-08-31T08:00:00.000Z", createdAgents: [] } as never] }],
  },
);
