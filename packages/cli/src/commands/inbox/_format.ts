import { formatAgentInboxAppItems as sharedFormatAgentInboxAppItems } from "@botiverse/raft-shared";
export type {
  AgentInboxTargetRow as InboxTargetRow,
  AgentInboxAppItem as InboxAppItem,
  AgentInboxItem as InboxItem,
} from "@botiverse/raft-shared";

import { axSurface } from "../../core/renderer";
import type {
  AgentApiInboxConversation,
  AgentApiInboxListResponse,
  AgentApiInboxView,
  AgentInboxAppItem,
  AgentInboxSourceSeal,
  AgentInboxTargetRow,
} from "@botiverse/raft-shared";

// The shared inbox projections render both here and inside daemon inbox
// notices; on the CLI side they are reply surfaces in their own right.
export const formatAgentInboxAppItems = axSurface(
  "App-sourced inbox item rows.",
  sharedFormatAgentInboxAppItems,
  {
    examples: [{ args: [[{ source: "app", itemId: "it-1", appId: "reminder", notificationClass: "fire", sourceRef: { kind: "reminder", id: "76d9397d" }, primaryAction: { kind: "run_command", commandId: "reminder.ack" }, actionCli: "raft reminder log", retention: "until_explicit_ack", title: "Reminder fired" }]] }],
  },
);

// ---------------------------------------------------------------------------
// `raft inbox check`: the agent's Activity panel.
//
// One entry point, no required flags. The server list is the durable unread
// set (newest activity first, keyset-paged); a managed runner's daemon snapshot
// only annotates it ("N new, not yet delivered") and contributes app items and
// the seal registry. Every row carries its one `open:` command and the output
// ends with exactly one `Next:` line.
// ---------------------------------------------------------------------------

export type InboxCheckInput = {
  view: AgentApiInboxView;
  before?: number;
  list: AgentApiInboxListResponse;
  /** Managed runners only: the daemon's pending (not yet delivered) targets. */
  pendingRows?: readonly AgentInboxTargetRow[];
  appItems?: readonly AgentInboxAppItem[];
  seals?: readonly AgentInboxSourceSeal[];
  /** Managed runner whose daemon snapshot could not be read. */
  daemonError?: string;
  /** No daemon at all (external agent): say app items/seals are unavailable. */
  appItemsUnavailable?: boolean;
  nowMs: number;
};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function formatAgo(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const seconds = Math.max(0, Math.round((nowMs - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function openCommand(target: string, afterSeq?: number): string {
  const after = afterSeq !== undefined && afterSeq > 0 ? ` --after ${afterSeq}` : "";
  return `raft message read --target "${target}"${after}`;
}

function pendingNote(row: AgentInboxTargetRow | undefined): string | null {
  if (!row || row.pendingCount <= 0) return null;
  return `${row.pendingCount} new, not yet delivered`;
}

type RenderedRow = { lines: string[]; next: string };

// The daemon groups every third-party app event for an agent under one
// transport-only DM target (the server names the channel
// `third-party-agent-events:<agentId>`). It is not a conversation:
// `raft message read` on it fails with "Channel not found", and its raw name
// means nothing to the agent. The events are fetched with `raft message check`.
const THIRD_PARTY_EVENTS_TARGET_PREFIX = "dm:@third-party-agent-events:";

function isThirdPartyEventsTarget(target: string): boolean {
  return target.startsWith(THIRD_PARTY_EVENTS_TARGET_PREFIX);
}

function renderThirdPartyEvents(count: number, latestSenderName: string | null | undefined): RenderedRow {
  const parts = ["Third-party app events", `${count} pending`];
  if (latestSenderName) parts.push(`latest @${latestSenderName}`);
  parts.push("fetch with raft message check");
  return { lines: [parts.join(" · ")], next: "fetch the third-party app events above: raft message check" };
}

function renderConversation(
  item: AgentApiInboxConversation,
  pending: AgentInboxTargetRow | undefined,
  nowMs: number,
): RenderedRow {
  if (isThirdPartyEventsTarget(item.target)) {
    return renderThirdPartyEvents(Math.max(item.unread, pending?.pendingCount ?? 0), pending?.latestSenderName ?? item.latestSenderName);
  }
  const parts = [item.target, `${item.unread} unread`];
  if (item.mentions > 0) parts.push(item.mentions === 1 ? "mentions you" : `mentions you ${item.mentions}x`);
  const note = pendingNote(pending);
  if (note) parts.push(note);
  const ago = formatAgo(item.latestAt, nowMs);
  const latest = [item.latestSenderName ? `@${item.latestSenderName}` : null, ago].filter(Boolean).join(" ");
  if (latest) parts.push(`latest ${latest}`);
  const open = openCommand(item.target, item.lastReadSeq);
  return { lines: [parts.join(" · "), `  open: ${open}`], next: `open the first conversation above: ${open}` };
}

function renderPendingOnly(row: AgentInboxTargetRow): RenderedRow {
  if (isThirdPartyEventsTarget(row.target)) return renderThirdPartyEvents(row.pendingCount, row.latestSenderName);
  const parts = [row.target, `${row.pendingCount} new, not yet delivered`];
  if (row.flags.includes("mention")) parts.push("mentions you");
  if (row.latestSenderName) parts.push(`latest @${row.latestSenderName}`);
  const afterSeq = row.firstPendingSeq !== undefined ? row.firstPendingSeq - 1 : undefined;
  const open = openCommand(row.target, afterSeq);
  return { lines: [parts.join(" · "), `  open: ${open}`], next: `open the first conversation above: ${open}` };
}

function formatHeader(input: InboxCheckInput, extraPending: number): string {
  const { totals } = input.list;
  const breakdown = `${plural(totals.dms, "DM")}, ${totals.mentions} with mentions`;
  if (input.view === "mentions") {
    if (totals.mentions === 0 && extraPending === 0) {
      return totals.conversations === 0
        ? "Inbox: nothing unread."
        : `Inbox: no unread mentions (${plural(totals.conversations, "unread conversation")} in total).`;
    }
    return `Inbox: ${plural(totals.mentions, "conversation")} with unread mentions (of ${plural(totals.conversations, "unread conversation")}).`;
  }
  if (totals.conversations === 0 && extraPending === 0) return "Inbox: nothing unread.";
  return `Inbox: ${plural(totals.conversations, "unread conversation")} (${breakdown}).`;
}

function formatSealRegistryText(seals: readonly AgentInboxSourceSeal[], items: readonly AgentInboxAppItem[]): string {
  if (seals.length === 0) return "";
  const lines = seals.map((seal) => {
    const sameSource = items.filter((item) =>
      item.appId === seal.appId
      && item.notificationClass === seal.notificationClass
      && item.sourceRef.kind === seal.sourceRef.kind
      && item.sourceRef.id === seal.sourceRef.id,
    );
    const exact = seal.sourceRef.revision !== undefined
      && sameSource.some((item) => item.sourceRef.revision === seal.sourceRef.revision);
    let status: string;
    if (seal.sourceRef.revision === undefined) {
      status = "DETACHED(id-only)";
    } else if (exact) {
      status = "SEALED(exact)";
    } else if (sameSource.length > 0) {
      const live = [...new Set(sameSource.map((item) => item.sourceRef.revision ?? "(none)"))].sort().join(",");
      status = `STALE(sealed-specimen-mutated) registered_revision=${seal.sourceRef.revision} live_revision=${live}`;
    } else {
      status = `DETACHED(no-live-item) registered_revision=${seal.sourceRef.revision}`;
    }
    return `seal app=${seal.appId} · class=${seal.notificationClass} · source=${seal.sourceRef.kind}:${seal.sourceRef.id} · status=${status} · owner=${seal.owner} · unseal_when=${seal.until}`;
  });
  return `Seal registry:\n${lines.join("\n")}`;
}

function formatInboxCheckText(input: InboxCheckInput): string {
  const { list, view } = input;
  const pendingByTarget = new Map((input.pendingRows ?? []).map((row) => [row.target, row]));
  const listed = new Set(list.items.map((item) => item.target));
  // Pending targets the durable list does not show yet (chain lag) lead the
  // first page -- they are the newest activity there is.
  const extraPending = input.before === undefined
    ? (input.pendingRows ?? []).filter((row) =>
      row.pendingCount > 0
      && !listed.has(row.target)
      && (view === "unread" || row.flags.includes("mention")))
    : [];
  const rows: RenderedRow[] = [
    ...extraPending.map(renderPendingOnly),
    ...list.items.map((item) => renderConversation(item, pendingByTarget.get(item.target), input.nowMs)),
  ];

  let header = formatHeader(input, extraPending.length);
  if (rows.length > 0) {
    header += input.before === undefined ? " Newest activity first." : ` Activity before seq ${input.before}, newest first.`;
  }
  const sections: string[] = [header];
  if (rows.length > 0) sections.push(rows.flatMap((row) => row.lines).join("\n"));

  const viewFlag = view === "mentions" ? " --view mentions" : "";
  const trailer: string[] = [];
  if (list.hasMore && list.nextBeforeSeq !== null) {
    trailer.push(`More: raft inbox check${viewFlag} --before ${list.nextBeforeSeq}`);
  }
  if (rows.length > 0) {
    trailer.push(`Next: ${rows[0].next}`);
  } else if (input.before !== undefined && (list.totals.conversations > 0)) {
    trailer.push(`Next: no older ${view === "mentions" ? "mentions" : "unread conversations"}; run raft inbox check${viewFlag} for the newest.`);
  } else if (view === "mentions" && list.totals.conversations > 0) {
    trailer.push("Next: run raft inbox check to list all unread conversations.");
  } else {
    trailer.push("Next: nothing to do; new messages will reach you as they arrive.");
  }
  sections.push(trailer.join("\n"));

  const appPart = formatAgentInboxAppItems(input.appItems ?? []);
  if (appPart) sections.push(appPart);
  const sealPart = formatSealRegistryText(input.seals ?? [], input.appItems ?? []);
  if (sealPart) sections.push(sealPart);
  if (input.appItemsUnavailable) sections.push("App items and reminder seals: not available for external agents.");
  if (input.daemonError) {
    sections.push(`Daemon pending buffer unavailable (${input.daemonError}); not-yet-delivered counts and app items are not shown.`);
  }
  return sections.join("\n\n");
}

const EXAMPLE_NOW_MS = Date.parse("2026-09-25T12:00:00.000Z");

export const formatInboxCheck = axSurface(
  "Agent Activity panel: durable unread conversations with per-row open commands, one Next line, then app items and seals.",
  formatInboxCheckText,
  {
    examples: [
      {
        args: [{
          view: "unread",
          nowMs: EXAMPLE_NOW_MS,
          list: {
            view: "unread",
            items: [
              { target: "dm:@richard", kind: "dm", unread: 3, mentions: 0, lastReadSeq: 1200, activitySeq: 1210, latestSenderName: "richard", latestAt: "2026-09-25T11:48:00.000Z" },
              { target: "#general:3f4b1fd4", kind: "thread", unread: 1, mentions: 1, lastReadSeq: 1180, activitySeq: 1190, latestSenderName: "alice", latestAt: "2026-09-25T11:00:00.000Z" },
            ],
            hasMore: true,
            nextBeforeSeq: 1190,
            totals: { conversations: 43, dms: 2, mentions: 5 },
          },
        }],
      },
      {
        args: [{
          view: "unread",
          nowMs: EXAMPLE_NOW_MS,
          list: { view: "unread", items: [], hasMore: false, nextBeforeSeq: null, totals: { conversations: 0, dms: 0, mentions: 0 } },
        }],
      },
      {
        args: [{
          view: "unread",
          nowMs: EXAMPLE_NOW_MS,
          list: { view: "unread", items: [], hasMore: false, nextBeforeSeq: null, totals: { conversations: 0, dms: 0, mentions: 0 } },
          pendingRows: [
            { target: "dm:@third-party-agent-events:3f4b1fd4-0000-4000-8000-000000000000", pendingCount: 20, latestSenderName: "stamp", latestSenderType: "third_party_app", flags: ["dm"] },
          ],
        }],
      },
    ],
  },
);
