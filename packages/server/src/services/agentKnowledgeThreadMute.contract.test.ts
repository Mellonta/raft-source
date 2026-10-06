import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const threadManual = readFileSync(
  new URL("../../../../manual/agent-knowledge/thread.md", import.meta.url),
  "utf8",
);

const cliOverview = readFileSync(
  new URL("../../../../manual/agent-knowledge/raft-cli-overview.md", import.meta.url),
  "utf8",
);

test("thread manual distinguishes parent mute from removing follow state", () => {
  const deliverySection = threadManual.match(
    /## Visibility vs delivery in a thread[\s\S]*?(?=\n## )/,
  )?.[0] ?? "";
  assert.match(deliverySection, /muting the parent channel suppresses ordinary Activity from the channel itself but does not suppress threads you follow/i);
  assert.match(deliverySection, /followers get ordinary delivery for each new reply until they unfollow/i);
  assert.match(deliverySection, /personal @mentions still pierce/i);
  assert.match(deliverySection, /unfollow when you want to remove one thread's follow record and stop its ordinary delivery/i);
  assert.doesNotMatch(deliverySection, /all its threads|bounded by parent channel mute/i);

  const notificationGotcha = threadManual
    .split("\n")
    .find((line) => line.includes("I got a thread reply notification")) ?? "";
  assert.match(notificationGotcha, /parent-channel mute does not stop a followed thread/i);
  assert.match(notificationGotcha, /direct @mention also reactivates an explicitly unfollowed thread/i);
  assert.match(notificationGotcha, /`raft thread unfollow --target <thread>`/);
  assert.match(notificationGotcha, /`raft thread unfollow`/);
  assert.match(notificationGotcha, /remove this thread's follow record and stop its ordinary delivery/i);
});

/**
 * `raft thread list` is a shipped agent CLI command (commit a329b9c6, released in
 * v1.16.0) that the topic's agent-command section did not mention, even though
 * `thread unfollow` — its natural read/write counterpart — was documented. The
 * page's own "What it CAN'T do" warning says a shipped feature silently rots an
 * absence list; this asserts the command is documented with the fields the CLI
 * actually renders (see packages/cli/src/commands/thread/_format.ts).
 */
test("thread manual documents the followed-thread list command and its fields", () => {
  const agentCommands = threadManual.match(
    /## What it CAN do[\s\S]*?(?=\n## )/,
  )?.[0] ?? "";
  // Fall back to the whole file when the section heading differs, so the tooth
  // still binds to real content rather than silently passing on an empty match.
  const section = agentCommands || threadManual;
  assert.match(section, /`raft thread list`/);
  // The command filters out unfollowed threads and threads the agent can no
  // longer access, so the docs must not claim it returns "every" followed
  // thread (channelService.listAgentFollowedThreads filters on
  // isNull(unfollowedAt) plus canAgentAccessChannel).
  assert.match(section, /threads this agent currently follows and can still access/i);
  assert.match(section, /Threads you unfollowed are excluded/i);
  assert.doesNotMatch(section, /every thread this agent/i);
  // Exactly the fields the CLI renders (packages/cli/src/commands/thread/_format.ts).
  // The API schema also carries parentMessageId/parentMessageShortId, but the
  // command does not print them, so documenting them would overstate the output.
  for (const field of [
    "target",
    "threadChannelId",
    "parentChannelRef",
    "followedAt",
    "reason",
    "doneAt",
  ]) {
    assert.match(
      section,
      new RegExp("`" + field + "`"),
      `the thread list documentation must name the ${field} field`,
    );
  }
  // reason is a free-form server label, not a closed vocabulary: the docs must
  // not present it as an exhaustive set.
  assert.match(section, /free-form label from the server, not a closed set/i);
  // The Manual is served to agents on any CLI version, and a daemon does not
  // self-upgrade, so an older machine sees `unknown command`. That must not be
  // read as "you follow nothing". The guidance used to live on this page, one
  // copy per feature page; it now lives once on the CLI overview, so the duty is
  // asserted where it moved, and its absence here is asserted too — a second copy
  // reappearing would be the drift the move was meant to end.
  assert.doesNotMatch(
    section,
    /unknown command/i,
    "the per-page version hint is retired in favour of the general rule on raft-cli-overview",
  );
});

test("the CLI overview carries the general rule for a CLI older than the Manual", () => {
  // The duty the per-page hints used to carry, now stated once on the overview.
  assert.match(cliOverview, /suspect the cli first/i);
  assert.match(cliOverview, /a documented command, subcommand, flag, or output field/i);
  assert.match(cliOverview, /is not "i follow no threads"/i);
  assert.match(cliOverview, /daemon does not upgrade itself/i);
  assert.match(cliOverview, /--help/i);
});
