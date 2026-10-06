// Hints: the "run this next" pointers in agent-facing text and in an
// outcome's `next`, in one structured form.
//
// A hint is the CLI words after `raft` (exactly as the CLI prints them, quotes
// included) plus, when an operation does the same thing, that operation's
// manifest name and arguments in manifest shape. `formatHint` renders it: the
// CLI form by default (byte-identical to the hand-written strings it
// replaced, so the CLI's pinned output does not move), or, for runtimes that
// call operations as model tools (`createRaft({ hints: "tool" })`), the tool
// call: `messages_read({ target: "#ops" })`.
//
// Every hint in packages/shared/src/agentOps, agentText and agentMessageText
// comes from a builder in `RAFT_HINTS`; hint.test.ts forbids hand-written
// `raft <group> <command>` strings there and pins every builder's CLI form,
// and the SDK checks every builder's arguments against the operation's schema.

/** How hints are rendered: `cli` (default) as `raft …` commands, `tool` as operation tool calls. */
export type RaftHintStyle = "cli" | "tool";

/** Options every hint-rendering operation accepts. */
export interface RaftHintOptions {
  hints?: RaftHintStyle;
}

/** The operation a next step maps to: manifest name and arguments in manifest shape. */
export interface RaftNextOperation {
  /** Manifest name (`RAFT_OPERATIONS`), for example `messages.read`. */
  name: string;
  args: Record<string, unknown>;
  /** Some required arguments are left for the caller (for example a message's `content`). */
  partial?: true;
}

export interface RaftHint {
  /** The CLI words after `raft`, as printed (quoted values keep their quotes). */
  cli: readonly string[];
  /** The operation that does the same; absent when no operation does (admin writes left to humans). */
  op?: RaftNextOperation;
  /** Required arguments the caller fills in; the tool form shows them as `name: …`. Present exactly when `op.partial`. */
  fill?: readonly string[];
  /** The operation is a typed method only (binary result, not a model tool); the tool form is a code call. */
  codeOnly?: true;
}

/** `tasks.updateStatus` → `tasks_update_status`: the manifest's tool name for an operation name. */
export function raftToolNameFor(name: string): string {
  return name.replace(/\./g, "_").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** Tool-form wording for a CLI command that has no operation (channel / server admin writes). */
export const RAFT_NO_TOOL_WORDING = "ask a human via an action card (`actions_prepare`)";

const ELLIPSIS = "…";

function q(value: string): string {
  return `"${value}"`;
}

function hint(cli: readonly string[], op?: { name: string; args: Record<string, unknown> }, fill?: readonly string[]): RaftHint {
  if (!op) return { cli };
  const args = Object.fromEntries(Object.entries(op.args).filter(([, value]) => value !== undefined));
  return fill && fill.length > 0
    ? { cli, op: { name: op.name, args, partial: true }, fill }
    : { cli, op: { name: op.name, args } };
}

function toolArgs(hint: RaftHint): string {
  const parts = Object.entries(hint.op?.args ?? {}).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  for (const key of hint.fill ?? []) parts.push(`${key}: ${ELLIPSIS}`);
  return parts.length > 0 ? `{ ${parts.join(", ")} }` : "{}";
}

/** Render a hint: `raft message read --target "#ops"` (cli) or `messages_read({ target: "#ops" })` (tool). */
export function formatHint(hint: RaftHint, style: RaftHintStyle = "cli"): string {
  if (style === "cli") return ["raft", ...hint.cli].join(" ");
  if (!hint.op) return RAFT_NO_TOOL_WORDING;
  if (hint.codeOnly) return `raft.${hint.op.name}(${toolArgs(hint)})`;
  return `${raftToolNameFor(hint.op.name)}(${toolArgs(hint)})`;
}

/** Just the command's name, for prose that lists commands: `raft channel join` (cli) or `channels_join` (tool). */
export function formatHintName(hint: RaftHint, style: RaftHintStyle = "cli"): string {
  if (style === "cli") return ["raft", ...hint.cli].join(" ");
  if (!hint.op) return RAFT_NO_TOOL_WORDING;
  return hint.codeOnly ? `raft.${hint.op.name}` : raftToolNameFor(hint.op.name);
}

/** A flag named in prose: `--limit` (cli) or `limit` (tool, the argument name). */
export function formatHintFlag(flag: string, arg: string, style: RaftHintStyle = "cli"): string {
  return style === "cli" ? `--${flag}` : arg;
}

/**
 * The hint as a next step: `command` is the rendered hint, `operation` the
 * structured call (when there is one). `args` keeps the step's own arguments.
 */
export function hintStep(
  kind: string,
  hint: RaftHint,
  why: string,
  style: RaftHintStyle = "cli",
  args?: Record<string, unknown>,
): { kind: string; command: string; args?: Record<string, unknown>; operation?: RaftNextOperation; why: string } {
  return {
    kind,
    command: formatHint(hint, style),
    ...(args ? { args } : {}),
    ...(hint.op ? { operation: hint.op } : {}),
    why,
  };
}

/** A conversation read window; `around` shows the short id the CLI prints and sends the full id. */
interface MessageReadHint {
  target: string;
  after?: number;
  before?: number;
  around?: { shown: string; id: string };
  /** Read the target's unread (`--unread`); never combined with after/before/around. */
  unread?: true;
}

/**
 * Every hint the shared formatters and operations produce. Placeholder
 * arguments (`<name>`, `"…"`) are `fill` keys: the CLI form prints the
 * placeholder, the tool form `name: …`.
 */
export const RAFT_HINTS = {
  messageRead: ({ target, after, before, around, unread }: MessageReadHint): RaftHint => hint(
    [
      "message", "read", "--target", q(target),
      ...(unread ? ["--unread"] : []),
      ...(after === undefined ? [] : ["--after", String(after)]),
      ...(before === undefined ? [] : ["--before", String(before)]),
      ...(around === undefined ? [] : ["--around", around.shown]),
    ],
    { name: "messages.read", args: { target, after, before, around: around?.id, ...(unread ? { unread } : {}) } },
  ),
  /** Send into a conversation; `content` is always the caller's. Without a target the target is left too. */
  messageSend: ({ target, attachmentId }: { target?: string; attachmentId?: string }): RaftHint => hint(
    [
      "message", "send",
      ...(target === undefined ? [] : ["--target", q(target)]),
      ...(attachmentId === undefined ? [] : ["--attachment-id", attachmentId]),
    ],
    { name: "messages.send", args: { target, attachmentIds: attachmentId === undefined ? undefined : [attachmentId] } },
    target === undefined ? ["target", "content"] : ["content"],
  ),
  /** The send command's name alone (prose, never a call). */
  messageSendName: (): RaftHint => hint(["message", "send"], { name: "messages.send", args: {} }, ["target", "content"]),
  messageCheck: (): RaftHint => hint(["message", "check"], { name: "inbox.check", args: {} }),
  inboxList: ({ view, before }: { view?: "mentions"; before?: number } = {}): RaftHint => hint(
    [
      "inbox", "check",
      ...(view === undefined ? [] : ["--view", view]),
      ...(before === undefined ? [] : ["--before", String(before)]),
    ],
    { name: "inbox.list", args: { view, before } },
  ),
  /** `query: true` is the `<name>` placeholder. */
  serverInfo: ({ view, offset, limit, query, joined }: {
    view?: "full" | "channels" | "agents" | "humans";
    offset?: number;
    limit?: number;
    query?: string | true;
    joined?: boolean;
  } = {}): RaftHint => hint(
    [
      "server", "info",
      ...(view === undefined ? [] : [`--${view}`]),
      ...(offset === undefined ? [] : ["--offset", String(offset)]),
      ...(limit === undefined ? [] : ["--limit", String(limit)]),
      ...(query === undefined ? [] : ["--query", query === true ? "<name>" : JSON.stringify(query)]),
      ...(joined ? ["--joined"] : []),
    ],
    { name: "server.info", args: { view, offset, limit, query: typeof query === "string" ? query : undefined, joined: joined ? true : undefined } },
    query === true ? ["query"] : undefined,
  ),
  /** `name` undefined is the `<name>` placeholder. */
  userInfo: ({ name, offset, limit }: { name?: string; offset?: number; limit?: number } = {}): RaftHint => hint(
    [
      "user", "info", name === undefined ? "<name>" : `@${name}`,
      ...(offset === undefined ? [] : ["--offset", String(offset)]),
      ...(limit === undefined ? [] : ["--limit", String(limit)]),
    ],
    { name: "users.info", args: { name: name === undefined ? undefined : `@${name}`, offset, limit } },
    name === undefined ? ["name"] : undefined,
  ),
  /** The `<name>` placeholder form. */
  channelInfo: (): RaftHint => hint(["channel", "info", "<name>"], { name: "channels.info", args: {} }, ["target"]),
  channelMembers: (target: string): RaftHint => hint(["channel", "members", q(target)], { name: "channels.members", args: { target } }),
  /** Channel attention commands by name (prose). */
  channelJoinName: (): RaftHint => hint(["channel", "join"], { name: "channels.join", args: {} }, ["target"]),
  channelLeaveName: (): RaftHint => hint(["channel", "leave"], { name: "channels.leave", args: {} }, ["target"]),
  channelMuteName: (): RaftHint => hint(["channel", "mute"], { name: "channels.mute", args: {} }, ["target"]),
  channelUnmuteName: (): RaftHint => hint(["channel", "unmute"], { name: "channels.unmute", args: {} }, ["target"]),
  threadUnfollowName: (): RaftHint => hint(["thread", "unfollow"], { name: "threads.unfollow", args: {} }, ["target"]),
  /** Channel / server admin writes: no operation by policy (a human acts through an action card). */
  channelCreateName: (): RaftHint => hint(["channel", "create"]),
  serverUpdateName: (): RaftHint => hint(["server", "update"]),
  taskClaim: ({ target, taskNumber }: { target: string; taskNumber: number }): RaftHint => hint(
    ["task", "claim", "--target", q(target), "--number", String(taskNumber)],
    { name: "tasks.claim", args: { target, taskNumbers: [taskNumber] } },
  ),
  taskListAll: (target: string): RaftHint => hint(
    ["task", "list", "--target", q(target), "--status", "all"],
    { name: "tasks.list", args: { target, status: "all" } },
  ),
  mentionAction: (action: "notify" | "add", resolutionId: string): RaftHint => hint(
    ["mention", action, resolutionId],
    { name: action === "notify" ? "mentions.notify" : "mentions.add", args: { resolutionIds: [resolutionId] } },
  ),
  mentionPending: (): RaftHint => hint(["mention", "pending"], { name: "mentions.pending", args: {} }),
  /** `intent` and `reason` are always the caller's. */
  manualGet: (topic: string): RaftHint => hint(
    ["manual", "get", topic, "--intent", q(ELLIPSIS), "--reason", q(ELLIPSIS)],
    { name: "manual.get", args: { topic } },
    ["intent", "reason"],
  ),
  /** The download pointer on message lines; the tool form mints a URL (one attachment: its id; several: left to fill). */
  attachmentView: (attachmentId?: string): RaftHint => hint(
    ["attachment", "view"],
    { name: "attachments.downloadUrl", args: { attachmentId } },
    attachmentId === undefined ? ["attachmentId"] : undefined,
  ),
  /** The binary download (typed method only): where an attachment whose URL cannot be minted is fetched. */
  attachmentDownload: (attachmentId: string): RaftHint => ({
    ...hint(["attachment", "view", attachmentId, "--output", "<path>"], { name: "attachments.download", args: { attachmentId } }),
    codeOnly: true,
  }),
} satisfies Record<string, (...args: never[]) => RaftHint>;

export type RaftHintBuilderName = keyof typeof RAFT_HINTS;
