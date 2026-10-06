// Test fixture: every hint builder in RAFT_HINTS, called the ways the shared
// formatters and operations call it, with its golden CLI form (the exact
// string the CLI printed before hints were structured; it must never move)
// and its tool form. hint.test.ts pins both; the SDK checks each `op` against
// the operation's request schema (packages/raft-sdk/src/hints.test.ts).

import { RAFT_HINTS, type RaftHint, type RaftHintBuilderName } from "./hint";

export interface RaftHintSample {
  hint: RaftHint;
  cli: string;
  tool: string;
}

const UUID = "00000000-1111-2222-3333-444444444444";
const MSG = "abcdef12-0000-4000-8000-000000000000";

export const RAFT_HINT_SAMPLES: Record<RaftHintBuilderName, RaftHintSample[]> = {
  messageRead: [
    { hint: RAFT_HINTS.messageRead({ target: "#ops" }), cli: `raft message read --target "#ops"`, tool: `messages_read({ target: "#ops" })` },
    { hint: RAFT_HINTS.messageRead({ target: "#ops", after: 12 }), cli: `raft message read --target "#ops" --after 12`, tool: `messages_read({ target: "#ops", after: 12 })` },
    { hint: RAFT_HINTS.messageRead({ target: "dm:@richard", before: 7 }), cli: `raft message read --target "dm:@richard" --before 7`, tool: `messages_read({ target: "dm:@richard", before: 7 })` },
    {
      hint: RAFT_HINTS.messageRead({ target: "dm:@richard:1234abcd", around: { shown: "abcdef12", id: MSG } }),
      cli: `raft message read --target "dm:@richard:1234abcd" --around abcdef12`,
      tool: `messages_read({ target: "dm:@richard:1234abcd", around: "${MSG}" })`,
    },
  ],
  messageSend: [
    { hint: RAFT_HINTS.messageSend({ target: "#ops:abcd1234" }), cli: `raft message send --target "#ops:abcd1234"`, tool: `messages_send({ target: "#ops:abcd1234", content: … })` },
    { hint: RAFT_HINTS.messageSend({ target: "dm:@name" }), cli: `raft message send --target "dm:@name"`, tool: `messages_send({ target: "dm:@name", content: … })` },
    {
      hint: RAFT_HINTS.messageSend({ target: "#ops", attachmentId: "att-1" }),
      cli: `raft message send --target "#ops" --attachment-id att-1`,
      tool: `messages_send({ target: "#ops", attachmentIds: ["att-1"], content: … })`,
    },
    {
      hint: RAFT_HINTS.messageSend({ attachmentId: "att-1" }),
      cli: `raft message send --attachment-id att-1`,
      tool: `messages_send({ attachmentIds: ["att-1"], target: …, content: … })`,
    },
  ],
  messageSendName: [{ hint: RAFT_HINTS.messageSendName(), cli: "raft message send", tool: "messages_send({ target: …, content: … })" }],
  messageCheck: [{ hint: RAFT_HINTS.messageCheck(), cli: "raft message check", tool: "inbox_check({})" }],
  inboxList: [
    { hint: RAFT_HINTS.inboxList(), cli: "raft inbox check", tool: "inbox_list({})" },
    { hint: RAFT_HINTS.inboxList({ before: 40 }), cli: "raft inbox check --before 40", tool: "inbox_list({ before: 40 })" },
    { hint: RAFT_HINTS.inboxList({ view: "mentions", before: 40 }), cli: "raft inbox check --view mentions --before 40", tool: `inbox_list({ view: "mentions", before: 40 })` },
  ],
  serverInfo: [
    { hint: RAFT_HINTS.serverInfo({ view: "channels" }), cli: "raft server info --channels", tool: `server_info({ view: "channels" })` },
    { hint: RAFT_HINTS.serverInfo({ view: "agents" }), cli: "raft server info --agents", tool: `server_info({ view: "agents" })` },
    { hint: RAFT_HINTS.serverInfo({ view: "humans" }), cli: "raft server info --humans", tool: `server_info({ view: "humans" })` },
    { hint: RAFT_HINTS.serverInfo({ view: "full" }), cli: "raft server info --full", tool: `server_info({ view: "full" })` },
    {
      hint: RAFT_HINTS.serverInfo({ view: "channels", offset: 50, limit: 50, joined: true }),
      cli: "raft server info --channels --offset 50 --limit 50 --joined",
      tool: `server_info({ view: "channels", offset: 50, limit: 50, joined: true })`,
    },
    {
      hint: RAFT_HINTS.serverInfo({ view: "agents", offset: 10, limit: 10, query: "ops" }),
      cli: `raft server info --agents --offset 10 --limit 10 --query "ops"`,
      tool: `server_info({ view: "agents", offset: 10, limit: 10, query: "ops" })`,
    },
    { hint: RAFT_HINTS.serverInfo({ view: "channels", query: true }), cli: "raft server info --channels --query <name>", tool: `server_info({ view: "channels", query: … })` },
    { hint: RAFT_HINTS.serverInfo({ view: "humans", query: true }), cli: "raft server info --humans --query <name>", tool: `server_info({ view: "humans", query: … })` },
  ],
  userInfo: [
    { hint: RAFT_HINTS.userInfo(), cli: "raft user info <name>", tool: "users_info({ name: … })" },
    { hint: RAFT_HINTS.userInfo({ name: "richard", offset: 50, limit: 50 }), cli: "raft user info @richard --offset 50 --limit 50", tool: `users_info({ name: "@richard", offset: 50, limit: 50 })` },
  ],
  channelInfo: [{ hint: RAFT_HINTS.channelInfo(), cli: "raft channel info <name>", tool: "channels_info({ target: … })" }],
  channelMembers: [{ hint: RAFT_HINTS.channelMembers("#general"), cli: `raft channel members "#general"`, tool: `channels_members({ target: "#general" })` }],
  channelJoinName: [{ hint: RAFT_HINTS.channelJoinName(), cli: "raft channel join", tool: "channels_join({ target: … })" }],
  channelLeaveName: [{ hint: RAFT_HINTS.channelLeaveName(), cli: "raft channel leave", tool: "channels_leave({ target: … })" }],
  channelMuteName: [{ hint: RAFT_HINTS.channelMuteName(), cli: "raft channel mute", tool: "channels_mute({ target: … })" }],
  channelUnmuteName: [{ hint: RAFT_HINTS.channelUnmuteName(), cli: "raft channel unmute", tool: "channels_unmute({ target: … })" }],
  threadUnfollowName: [{ hint: RAFT_HINTS.threadUnfollowName(), cli: "raft thread unfollow", tool: "threads_unfollow({ target: … })" }],
  channelCreateName: [{ hint: RAFT_HINTS.channelCreateName(), cli: "raft channel create", tool: "ask a human via an action card (`actions_prepare`)" }],
  serverUpdateName: [{ hint: RAFT_HINTS.serverUpdateName(), cli: "raft server update", tool: "ask a human via an action card (`actions_prepare`)" }],
  taskClaim: [
    { hint: RAFT_HINTS.taskClaim({ target: "#proj-sdk", taskNumber: 3 }), cli: `raft task claim --target "#proj-sdk" --number 3`, tool: `tasks_claim({ target: "#proj-sdk", taskNumbers: [3] })` },
  ],
  taskListAll: [
    { hint: RAFT_HINTS.taskListAll("#proj-sdk"), cli: `raft task list --target "#proj-sdk" --status all`, tool: `tasks_list({ target: "#proj-sdk", status: "all" })` },
  ],
  mentionAction: [
    { hint: RAFT_HINTS.mentionAction("notify", UUID), cli: `raft mention notify ${UUID}`, tool: `mentions_notify({ resolutionIds: ["${UUID}"] })` },
    { hint: RAFT_HINTS.mentionAction("add", UUID), cli: `raft mention add ${UUID}`, tool: `mentions_add({ resolutionIds: ["${UUID}"] })` },
  ],
  mentionPending: [{ hint: RAFT_HINTS.mentionPending(), cli: "raft mention pending", tool: "mentions_pending({})" }],
  manualGet: [
    { hint: RAFT_HINTS.manualGet("tasks"), cli: `raft manual get tasks --intent "…" --reason "…"`, tool: `manual_get({ topic: "tasks", intent: …, reason: … })` },
  ],
  attachmentView: [
    { hint: RAFT_HINTS.attachmentView(), cli: "raft attachment view", tool: "attachments_download_url({ attachmentId: … })" },
    { hint: RAFT_HINTS.attachmentView("att-1"), cli: "raft attachment view", tool: `attachments_download_url({ attachmentId: "att-1" })` },
  ],
  attachmentDownload: [
    { hint: RAFT_HINTS.attachmentDownload("att-1"), cli: "raft attachment view att-1 --output <path>", tool: `raft.attachments.download({ attachmentId: "att-1" })` },
  ],
};
