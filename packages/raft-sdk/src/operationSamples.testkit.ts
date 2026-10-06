// Test fixture: one valid call per manifest operation, as `invoke` args and as
// the equivalent typed call (operations.test.ts, invoke.test.ts).

import type { Raft } from "./raft";
import type { RaftOperationName } from "./operations";

const T = "#general";
const MSG = "00000000-1111-2222-3333-444444444444";

export const OPERATION_SAMPLES: Record<RaftOperationName, { args: Record<string, unknown>; typed: (raft: Raft) => Promise<unknown> }> = {
  "identity.whoami": { args: {}, typed: (r) => r.identity.whoami() },
  "inbox.check": { args: { limit: 5 }, typed: (r) => r.inbox.check({ limit: 5 }) },
  "inbox.drain": {
    args: { limit: 5 },
    typed: async (r) => {
      const drain = r.inbox.drain({ limit: 5 });
      for (let step = await drain.next(); !step.done; step = await drain.next()) { /* consume */ }
    },
  },
  "inbox.commit": { args: {}, typed: (r) => r.inbox.commit() },
  "inbox.list": { args: { view: "mentions", limit: 5 }, typed: (r) => r.inbox.list({ view: "mentions", limit: 5 }) },
  "messages.read": { args: { target: T, after: 10, limit: 20 }, typed: (r) => r.messages.read({ target: T, after: 10, limit: 20 }) },
  "messages.send": { args: { target: T, content: "hi", idempotencyKey: "k-1" }, typed: (r) => r.messages.send({ target: T, content: "hi", idempotencyKey: "k-1" }) },
  "messages.reply": {
    args: { message: { target: `${T}:abcd1234` }, content: "hi", idempotencyKey: "k-2" },
    typed: (r) => r.messages.reply({ target: `${T}:abcd1234` }, { content: "hi", idempotencyKey: "k-2" }),
  },
  "messages.search": { args: { query: "deploy", limit: 5 }, typed: (r) => r.messages.search({ query: "deploy", limit: 5 }) },
  "messages.resolve": { args: { messageId: "00000000" }, typed: (r) => r.messages.resolve({ messageId: "00000000" }) },
  "messages.react": { args: { messageId: MSG, emoji: "👍" }, typed: (r) => r.messages.react({ messageId: MSG, emoji: "👍" }) },
  "messages.unreact": { args: { messageId: MSG, emoji: "👍" }, typed: (r) => r.messages.unreact({ messageId: MSG, emoji: "👍" }) },
  "attachments.downloadUrl": { args: { attachmentId: "att-1" }, typed: (r) => r.attachments.downloadUrl({ attachmentId: "att-1" }) },
  "attachments.comments": { args: { attachmentId: "att-1", limit: 3 }, typed: (r) => r.attachments.comments({ attachmentId: "att-1", limit: 3 }) },
  "mentions.pending": { args: { limit: 3 }, typed: (r) => r.mentions.pending({ limit: 3 }) },
  "mentions.notify": { args: { resolutionIds: ["r-1"] }, typed: (r) => r.mentions.notify({ resolutionIds: ["r-1"] }) },
  "mentions.add": { args: { resolutionIds: ["r-1"] }, typed: (r) => r.mentions.add({ resolutionIds: ["r-1"] }) },
  "mentions.delivery": { args: { messageId: MSG }, typed: (r) => r.mentions.delivery({ messageId: MSG }) },
  "actions.prepare": {
    args: { target: T, action: { type: "channel:create", name: "new-chan" }, idempotencyKey: "k-card" },
    typed: (r) => r.actions.prepare({ target: T, action: { type: "channel:create", name: "new-chan", visibility: "public" }, idempotencyKey: "k-card" }),
  },
  "manual.get": { args: { topic: "tasks", intent: "track my work with tasks", reason: "deciding how to claim" }, typed: (r) => r.manual.get({ topic: "tasks", intent: "track my work with tasks", reason: "deciding how to claim" }) },
  "manual.search": { args: { query: "tasks", intent: "track my work with tasks", reason: "deciding how to claim" }, typed: (r) => r.manual.search({ query: "tasks", intent: "track my work with tasks", reason: "deciding how to claim" }) },
  "tasks.claim": { args: { target: T, taskNumbers: [3] }, typed: (r) => r.tasks.claim({ target: T, taskNumbers: [3] }) },
  "tasks.list": { args: { target: T, status: "todo" }, typed: (r) => r.tasks.list({ target: T, status: "todo" }) },
  "tasks.create": { args: { target: T, tasks: [{ title: "Do it" }], idempotencyKey: "k-create" }, typed: (r) => r.tasks.create({ target: T, tasks: [{ title: "Do it" }], idempotencyKey: "k-create" }) },
  "tasks.unclaim": { args: { target: T, taskNumber: 3 }, typed: (r) => r.tasks.unclaim({ target: T, taskNumber: 3 }) },
  "tasks.assign": { args: { target: T, taskNumber: 3, assignee: "@grace" }, typed: (r) => r.tasks.assign({ target: T, taskNumber: 3, assignee: "@grace" }) },
  "tasks.unassign": { args: { target: T, taskNumber: 3 }, typed: (r) => r.tasks.unassign({ target: T, taskNumber: 3 }) },
  "tasks.updateStatus": { args: { target: T, taskNumber: 3, status: "in_review" }, typed: (r) => r.tasks.updateStatus({ target: T, taskNumber: 3, status: "in_review" }) },
  "tasks.amend": { args: { target: T, taskNumber: 3, title: "New" }, typed: (r) => r.tasks.amend({ target: T, taskNumber: 3, title: "New" }) },
  "tasks.history": { args: { target: T, taskNumber: 3 }, typed: (r) => r.tasks.history({ target: T, taskNumber: 3 }) },
  "tasks.show": { args: { target: T, taskNumber: 3 }, typed: (r) => r.tasks.show({ target: T, taskNumber: 3 }) },
  "tasks.convert": { args: { target: T, messageId: "00000000" }, typed: (r) => r.tasks.convert({ target: T, messageId: "00000000" }) },
  "tasks.delete": { args: { target: T, taskNumber: 3 }, typed: (r) => r.tasks.delete({ target: T, taskNumber: 3 }) },
  "channels.join": { args: { target: T }, typed: (r) => r.channels.join({ target: T }) },
  "channels.leave": { args: { target: T }, typed: (r) => r.channels.leave({ target: T }) },
  "channels.mute": { args: { target: T }, typed: (r) => r.channels.mute({ target: T }) },
  "channels.unmute": { args: { target: T }, typed: (r) => r.channels.unmute({ target: T }) },
  "channels.members": { args: { target: T }, typed: (r) => r.channels.members({ target: T }) },
  "channels.info": { args: { target: T }, typed: (r) => r.channels.info({ target: T }) },
  "threads.list": { args: {}, typed: (r) => r.threads.list() },
  "threads.unfollow": { args: { target: `${T}:abcd1234`, reason: "done" }, typed: (r) => r.threads.unfollow({ target: `${T}:abcd1234`, reason: "done" }) },
  "server.info": { args: { view: "channels", limit: 10 }, typed: (r) => r.server.info({ view: "channels", limit: 10 }) },
  "users.info": { args: { name: "@richard", limit: 10 }, typed: (r) => r.users.info({ name: "@richard", limit: 10 }) },
  "profile.show": { args: { target: "@richard" }, typed: (r) => r.profile.show({ target: "@richard" }) },
  "profile.update": { args: { displayName: "Grace" }, typed: (r) => r.profile.update({ displayName: "Grace" }) },
};
