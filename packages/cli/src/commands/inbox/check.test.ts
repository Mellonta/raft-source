import assert from "node:assert/strict";

import type { AgentApiInboxListResponse } from "@botiverse/raft-shared";
import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import type { CliIo } from "../../core/io";
import { inboxCheckCommand } from "./check";
import { formatInboxCheck, type InboxCheckInput } from "./_format";

function memoryIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
    },
  };
}

const agentContext: AgentContext = {
  agentId: "agent-1",
  serverUrl: "https://slock.example",
  serverId: "server-1",
  token: "secret-token",
  clientMode: "managed-runner",
  secretSource: "agent-proxy-token-env",
  activeCapabilities: null,
};

const NOW_MS = Date.parse("2026-09-25T12:00:00.000Z");

function emptyList(overrides: Partial<AgentApiInboxListResponse> = {}): AgentApiInboxListResponse {
  return {
    view: "unread",
    items: [],
    hasMore: false,
    nextBeforeSeq: null,
    totals: { conversations: 0, dms: 0, mentions: 0 },
    ...overrides,
  };
}

const dmRow = {
  target: "dm:@richard",
  kind: "dm" as const,
  unread: 3,
  mentions: 0,
  lastReadSeq: 1200,
  activitySeq: 1210,
  latestSenderName: "richard",
  latestAt: "2026-09-25T11:48:00.000Z",
};
const threadRow = {
  target: "#general:3f4b1fd4",
  kind: "thread" as const,
  unread: 1,
  mentions: 1,
  lastReadSeq: 1180,
  activitySeq: 1190,
  latestSenderName: "alice",
  latestAt: "2026-09-25T11:00:00.000Z",
};

/**
 * Routes the CLI's two reads: the durable server list and (managed runners)
 * the daemon pending snapshot. A route given as `null` is not expected.
 */
function routedClient(input: {
  list?: ApiResponse<unknown> | AgentApiInboxListResponse;
  daemon?: unknown;
  daemonResponse?: ApiResponse<unknown>;
}) {
  const requests: string[] = [];
  const ok = (data: unknown): ApiResponse<unknown> => ({ ok: true, status: 200, error: null, data });
  const client = {
    request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
      requests.push(`${method} ${path}`);
      if (path.startsWith("/internal/agent-api/inbox/conversations")) {
        const list = input.list ?? emptyList();
        return "ok" in list && "status" in list ? list as ApiResponse<unknown> : ok(list);
      }
      if (path === "/internal/agent-api/inbox") {
        return input.daemonResponse ?? ok(input.daemon ?? { rows: [] });
      }
      throw new Error(`unexpected request ${method} ${path}`);
    },
  };
  return { client: client as any, requests };
}

function render(input: Partial<InboxCheckInput> & Pick<InboxCheckInput, "list">): string {
  return formatInboxCheck({ view: "unread", nowMs: NOW_MS, ...input });
}

test("formatter: empty inbox says so and ends with one Next line", () => {
  assert.equal(render({ list: emptyList() }), [
    "Inbox: nothing unread.",
    "",
    "Next: nothing to do; new messages will reach you as they arrive.",
  ].join("\n"));
});

test("formatter: a page with more renders open commands, the More trailer, and exactly one Next line", () => {
  const output = render({
    list: emptyList({ items: [dmRow, threadRow], hasMore: true, nextBeforeSeq: 1190, totals: { conversations: 43, dms: 2, mentions: 5 } }),
  });
  assert.equal(output, [
    "Inbox: 43 unread conversations (2 DMs, 5 with mentions). Newest activity first.",
    "",
    "dm:@richard · 3 unread · latest @richard 12m ago",
    "  open: raft message read --target \"dm:@richard\" --after 1200",
    "#general:3f4b1fd4 · 1 unread · mentions you · latest @alice 1h ago",
    "  open: raft message read --target \"#general:3f4b1fd4\" --after 1180",
    "",
    "More: raft inbox check --before 1190",
    "Next: open the first conversation above: raft message read --target \"dm:@richard\" --after 1200",
  ].join("\n"));
  assert.equal((output.match(/^Next:/gm) ?? []).length, 1);
});

test("formatter: the last page has no More line and names its seq window", () => {
  const output = render({
    before: 1190,
    list: emptyList({ items: [{ ...dmRow, target: "#random", kind: "channel", latestSenderName: null, latestAt: null, lastReadSeq: 0 }], totals: { conversations: 43, dms: 2, mentions: 5 } }),
  });
  assert.equal(output, [
    "Inbox: 43 unread conversations (2 DMs, 5 with mentions). Activity before seq 1190, newest first.",
    "",
    "#random · 3 unread",
    "  open: raft message read --target \"#random\"",
    "",
    "Next: open the first conversation above: raft message read --target \"#random\"",
  ].join("\n"));
  assert.doesNotMatch(output, /^More:/m);
});

test("formatter: a page past the end points back to the newest page", () => {
  const output = render({ before: 5, list: emptyList({ totals: { conversations: 3, dms: 0, mentions: 0 } }) });
  assert.equal(output, [
    "Inbox: 3 unread conversations (0 DMs, 0 with mentions).",
    "",
    "Next: no older unread conversations; run raft inbox check for the newest.",
  ].join("\n"));
});

test("formatter: mentions view has a mentions header and keeps the view on the More line", () => {
  const output = render({
    view: "mentions",
    list: emptyList({ view: "mentions", items: [threadRow], hasMore: true, nextBeforeSeq: 1190, totals: { conversations: 43, dms: 2, mentions: 5 } }),
  });
  assert.match(output, /^Inbox: 5 conversations with unread mentions \(of 43 unread conversations\)\. Newest activity first\./);
  assert.match(output, /^More: raft inbox check --view mentions --before 1190$/m);

  const none = render({ view: "mentions", list: emptyList({ view: "mentions", totals: { conversations: 4, dms: 1, mentions: 0 } }) });
  assert.equal(none, [
    "Inbox: no unread mentions (4 unread conversations in total).",
    "",
    "Next: run raft inbox check to list all unread conversations.",
  ].join("\n"));
});

test("formatter: daemon pending rows annotate listed targets and lead the first page when the list lags", () => {
  const output = render({
    list: emptyList({ items: [dmRow], totals: { conversations: 1, dms: 1, mentions: 0 } }),
    pendingRows: [
      { target: "dm:@richard", pendingCount: 2, flags: ["dm"] },
      { target: "#ops", pendingCount: 1, firstPendingSeq: 1300, latestSenderName: "bob", flags: ["mention"] },
    ],
  });
  assert.equal(output, [
    "Inbox: 1 unread conversation (1 DM, 0 with mentions). Newest activity first.",
    "",
    "#ops · 1 new, not yet delivered · mentions you · latest @bob",
    "  open: raft message read --target \"#ops\" --after 1299",
    "dm:@richard · 3 unread · 2 new, not yet delivered · latest @richard 12m ago",
    "  open: raft message read --target \"dm:@richard\" --after 1200",
    "",
    "Next: open the first conversation above: raft message read --target \"#ops\" --after 1299",
  ].join("\n"));

  // Pending-only rows belong to the newest page, not to older pages.
  const older = render({ before: 900, list: emptyList({ items: [dmRow], totals: { conversations: 1, dms: 1, mentions: 0 } }), pendingRows: [{ target: "#ops", pendingCount: 1, flags: [] }] });
  assert.doesNotMatch(older, /#ops/);
});

// Task #175: the daemon groups third-party app events under one internal
// transport target. `raft message read` on that target always fails with
// "Channel not found"; the events are fetched with `raft message check`.
test("formatter: the grouped third-party app events row points at message check, not an unreadable target", () => {
  const thirdPartyRow = {
    target: "dm:@third-party-agent-events:agent-1",
    channelType: "dm",
    pendingCount: 20,
    latestSenderName: "stamp",
    latestSenderType: "third_party_app" as const,
    flags: ["dm" as const],
  };
  const output = render({
    list: emptyList({ items: [dmRow], totals: { conversations: 1, dms: 1, mentions: 0 } }),
    pendingRows: [thirdPartyRow],
  });
  assert.equal(output, [
    "Inbox: 1 unread conversation (1 DM, 0 with mentions). Newest activity first.",
    "",
    "Third-party app events · 20 pending · latest @stamp · fetch with raft message check",
    "dm:@richard · 3 unread · latest @richard 12m ago",
    "  open: raft message read --target \"dm:@richard\" --after 1200",
    "",
    "Next: fetch the third-party app events above: raft message check",
  ].join("\n"));
  assert.doesNotMatch(output, /third-party-agent-events/);
  assert.doesNotMatch(output, /raft message read --target "dm:@third-party/);
  assert.equal((output.match(/^Next:/gm) ?? []).length, 1);
});

test("inbox check reads the server list and the daemon snapshot for managed runners", async () => {
  const { io, stdout, stderr } = memoryIo();
  const routed = routedClient({
    list: emptyList({ items: [dmRow], totals: { conversations: 1, dms: 1, mentions: 0 } }),
    daemon: { rows: [{ target: "dm:@richard", pendingCount: 2, flags: ["dm"] }] },
  });
  const ctx = createCommandContext({ io, loadAgentContext: () => agentContext, createApiClient: () => routed.client });

  await inboxCheckCommand.handler(ctx, { before: "1300", view: "mentions" });

  assert.deepEqual(routed.requests.sort(), [
    "GET /internal/agent-api/inbox",
    "GET /internal/agent-api/inbox/conversations?view=mentions&before_seq=1300",
  ]);
  assert.deepEqual(stderr, []);
  assert.match(stdout.join(""), /dm:@richard · 3 unread · 2 new, not yet delivered/);
  assert.doesNotMatch(stdout.join(""), /not available for external agents/);
});

test("inbox check works for external agents from the server list alone", async () => {
  const { io, stdout } = memoryIo();
  const routed = routedClient({ list: emptyList({ items: [threadRow], totals: { conversations: 1, dms: 0, mentions: 1 } }) });
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => ({ ...agentContext, clientMode: "self-hosted-runner" }),
    createApiClient: () => routed.client,
  });

  await inboxCheckCommand.handler(ctx, {});

  assert.deepEqual(routed.requests, ["GET /internal/agent-api/inbox/conversations"]);
  assert.match(stdout.join(""), /^#general:3f4b1fd4 · 1 unread · mentions you/m);
  // No daemon, so no app items or seals: said once, not silently omitted.
  assert.equal(stdout.join("").match(/^App items and reminder seals: not available for external agents\.$/gm)?.length, 1);
});

test("inbox check maps 503 INBOX_UNAVAILABLE to a retry hint", async () => {
  const { io } = memoryIo();
  const routed = routedClient({
    list: { ok: false, status: 503, error: "Inbox is temporarily unavailable", errorCode: "INBOX_UNAVAILABLE", data: null },
  });
  const ctx = createCommandContext({ io, loadAgentContext: () => agentContext, createApiClient: () => routed.client });

  await assert.rejects(
    async () => { await inboxCheckCommand.handler(ctx, {}); },
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "INBOX_UNAVAILABLE");
      assert.equal(
        (err as { suggestedNextAction?: string }).suggestedNextAction,
        "Retry in a moment; to drain new messages now use raft message check.",
      );
      return true;
    },
  );
});

test("inbox check rejects bad flags before network I/O", async () => {
  const { io } = memoryIo();
  const routed = routedClient({});
  const ctx = createCommandContext({ io, loadAgentContext: () => agentContext, createApiClient: () => routed.client });
  await assert.rejects(async () => { await inboxCheckCommand.handler(ctx, { view: "all" }); }, /--view must be one of unread, mentions/);
  await assert.rejects(async () => { await inboxCheckCommand.handler(ctx, { before: "abc" }); }, /--before must be a positive integer/);
  assert.deepEqual(routed.requests, []);
});

test("inbox check still lists conversations when the daemon snapshot fails, and says what is missing", async () => {
  const { io, stdout } = memoryIo();
  const routed = routedClient({
    list: emptyList({ items: [dmRow], totals: { conversations: 1, dms: 1, mentions: 0 } }),
    daemonResponse: { ok: false, status: 502, error: "daemon down", data: null },
  });
  const ctx = createCommandContext({ io, loadAgentContext: () => agentContext, createApiClient: () => routed.client });
  await inboxCheckCommand.handler(ctx, {});
  const output = stdout.join("");
  assert.match(output, /^dm:@richard · 3 unread/m);
  assert.match(output, /Daemon pending buffer unavailable \(daemon down\)/);
});

test("inbox check renders twenty sealed reminder rows without ack actions and one unsealed control", async () => {
  const { io, stdout } = memoryIo();
  const items = Array.from({ length: 21 }, (_, index) => {
    const id = `${String(index + 1).padStart(8, "0")}-1234-4123-8123-123456789abc`;
    return {
      source: "app",
      itemId: `reminder:${id}:1`,
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: { kind: "reminder", id, revision: "1" },
      primaryAction: { kind: "run_command", commandId: "reminder.ack" },
      actionCli: `raft reminder ack --id ${id.slice(0, 8)} --revision 1`,
      retention: "until_explicit_ack",
      ...(index < 20
        ? { seal: { owner: "@Stone", until: "signed carrier deployed", sealedAtMs: 1_000 + index } }
        : {}),
    };
  });
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => routedClient({ daemon: { rows: [], items } }).client,
  });

  await inboxCheckCommand.handler(ctx);

  const output = stdout.join("");
  assert.equal((output.match(/sealed owner=@Stone/g) ?? []).length, 20);
  assert.equal((output.match(/unseal_when=signed carrier deployed/g) ?? []).length, 20);
  assert.equal((output.match(/action=raft reminder ack/g) ?? []).length, 1);
});

test("inbox check reports revision drift and detached id-only seals without projecting them onto items", async () => {
  const { io, stdout } = memoryIo();
  const reminderId = "12345678-1234-4123-8123-123456789abc";
  const detachedId = "87654321-1234-4123-8123-123456789abc";
  const item = {
    source: "app",
    itemId: `reminder:${reminderId}:8`,
    appId: "system.reminder",
    notificationClass: "due",
    sourceRef: { kind: "reminder", id: reminderId, revision: "8" },
    primaryAction: { kind: "run_command", commandId: "reminder.ack" },
    actionCli: "raft reminder ack --id 12345678 --revision 8",
    retention: "until_explicit_ack",
  };
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => routedClient({ daemon: {
          rows: [],
          items: [item],
          seals: [
            {
              appId: "system.reminder",
              notificationClass: "due",
              sourceRef: { kind: "reminder", id: reminderId, revision: "7" },
              owner: "@Stone",
              until: "release",
              sealedAtMs: 1_000,
            },
            {
              appId: "system.reminder",
              notificationClass: "due",
              sourceRef: { kind: "reminder", id: detachedId },
              owner: "@Stone",
              until: "release",
              sealedAtMs: 1_001,
            },
          ],
        } }).client,
  });

  await inboxCheckCommand.handler(ctx);

  const output = stdout.join("");
  assert.match(output, /action=raft reminder ack --id 12345678 --revision 8/);
  assert.doesNotMatch(output, /sealed owner=/);
  assert.match(output, /STALE\(sealed-specimen-mutated\) registered_revision=7 live_revision=8/);
  assert.match(output, /DETACHED\(id-only\)/);
});

test("inbox check command renders structured sourceRef and exact actionCli from OS mint", async () => {
  const { io, stdout, stderr } = memoryIo();
  const appItem = {
    source: "app" as const,
    itemId: "item-uuid-0001",
    appId: "test.fixture",
    notificationClass: "due",
    sourceRef: {
      kind: "fixture",
      id: "aaaaaaaa-0000-4000-8000-000000000001",
      revision: "3",
    },
    primaryAction: { kind: "run_command" as const, commandId: "fixture.log" },
    actionCli: "raft fixture log --id aaaaaaaa",
    retention: "until_source_read" as const,
    title: "Due",
  };
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => routedClient({ daemon: {
          rows: [],
          items: [appItem],
          pending_app_items: 1,
        } }).client,
  });
  await inboxCheckCommand.handler(ctx);
  assert.deepEqual(stderr, []);
  const output = stdout.join("");
  assert.match(output, /App items: 1/);
  assert.match(output, /sourceRef=fixture:aaaaaaaa-0000-4000-8000-000000000001:3/);
  assert.match(output, /action=raft fixture log --id aaaaaaaa/);
  assert.doesNotMatch(output, /msg=|sender|seq=/);
});
