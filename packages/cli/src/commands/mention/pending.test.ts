import assert from "node:assert/strict";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import type { CliIo } from "../../core/io";
import { formatPendingMentionActions } from "./_format";
import { mentionPendingCommand } from "./pending";

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
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

test("mention pending calls pending endpoint and renders actions", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path });
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            pendingMentionActions: [{
              resolutionId: "r-1",
              messageId: "m-1",
              targetType: "agent",
              targetHandle: "@Noel",
              reason: "not in channel",
              availableActions: ["notify"],
            }],
          },
        };
      },
    }) as any,
  });

  await mentionPendingCommand.handler(ctx, {});

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/mention-actions/pending" },
  ]);
  assert.deepEqual(stderr, []);
  assert.match(stdout.join(""), /Pending mention actions/);
  assert.match(stdout.join(""), /raft mention notify r-1/);
  assert.doesNotMatch(stdout.join(""), /raft mention add r-1/);
});

test("mention pending --json emits normalized action payload", async () => {
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: { pendingMentionActions: [{ resolutionId: "r-1", targetHandle: "@Noel" }] },
      }),
    }) as any,
  });

  await mentionPendingCommand.handler(ctx, { json: true });

  assert.deepEqual(JSON.parse(stdout.join("")), {
    ok: true,
    pendingMentionActions: [{
      resolutionId: "r-1",
      messageId: "",
      targetType: "unknown",
      targetHandle: "@Noel",
      reason: "Mention target was not notified at send time.",
      availableActions: [],
      expiresAt: null,
    }],
    // The server did not send `has_more`; `null` keeps that distinguishable from `false`.
    truncated: null,
    limit: null,
  });
});

test("--json carries the server's has_more as `truncated`, and the requested limit", async () => {
  const paths: string[] = [];
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, path: string): Promise<ApiResponse<unknown>> => {
        paths.push(path);
        return {
          ok: true,
          status: 200,
          error: null,
          data: { pendingMentionActions: [{ resolutionId: "r-1" }], has_more: true },
        };
      },
    }) as any,
  });

  await mentionPendingCommand.handler(ctx, { json: true, limit: "2" });

  const out = JSON.parse(stdout.join("")) as { truncated: unknown; limit: unknown };
  assert.equal(out.truncated, true);
  assert.equal(out.limit, 2);
  // Passed through, not dropped: the route reads `limit` off the query string, and the previous
  // command sent none at all, so every call silently took the server default.
  assert.equal(paths.length, 1);
  assert.match(paths[0]!, /limit=2/);
});

test("--limit 100 is accepted: the bound is the server's cap, not one below it", async () => {
  const paths: string[] = [];
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_m: string, path: string): Promise<ApiResponse<unknown>> => {
        paths.push(path);
        return { ok: true, status: 200, error: null, data: { pendingMentionActions: [], has_more: false } };
      },
    }) as any,
  });
  await mentionPendingCommand.handler(ctx, { json: true, limit: "100" });
  assert.match(paths[0]!, /limit=100/);
});

test("at the cap, truncated=true stops telling the reader to raise --limit", async () => {
  const rows = Array.from({ length: 2 }, (_, i) => ({
    resolutionId: `r-${i}`, messageId: "m", targetType: "agent", targetHandle: "@a",
    reason: "not_in_conversation", availableActions: ["notify"], expiresAt: null,
  }));
  const atCap = formatPendingMentionActions(rows, { source: "pending", hasMore: true, limit: 100 });
  const below = formatPendingMentionActions(rows, { source: "pending", hasMore: true, limit: 10 });

  // The route's query contract is `{ limit }` alone -- no offset, no cursor -- so past 100 the
  // advice "raise --limit" points at a wall. Naming that is the difference between a recovery
  // hint and a loop.
  assert.match(atCap, /cannot be reached from here/);
  assert.doesNotMatch(atCap, /raise --limit/);
  // The advice must not promise an action that over half the rows cannot take: a row with an
  // empty availableActions offers the caller nothing to resolve. Asserting the qualifier, not
  // just its absence-of-"raise", because "resolve these" was itself the empty instruction.
  assert.match(atCap, /resolve what you can and re-run/);
  assert.match(atCap, /will remain until they expire/);
  assert.doesNotMatch(atCap, /resolve these and re-run/);
  assert.match(below, /raise --limit/);
  assert.doesNotMatch(below, /cannot be reached from here/);
});

test("the three JSON states are distinguishable only by identity, not by falsiness", async () => {
  // Pins the LIMIT of this serialisation rather than a virtue of it: `!truncated` is true for
  // both `false` and `null`, so a falsy check cannot tell "complete" from "not asserted".
  // Consumers must compare identity. If someone later "simplifies" unknown to `false`, the
  // identity assertions below go red and this reasoning gets re-read.
  const seen: unknown[] = [];
  for (const body of [
    { pendingMentionActions: [], has_more: true },
    { pendingMentionActions: [], has_more: false },
    { pendingMentionActions: [] },
  ]) {
    const { io, stdout } = memoryIo();
    const ctx = createCommandContext({
      io,
      loadAgentContext: () => agentContext,
      createApiClient: () => ({
        request: async (): Promise<ApiResponse<unknown>> => ({ ok: true, status: 200, error: null, data: body }),
      }) as any,
    });
    await mentionPendingCommand.handler(ctx, { json: true });
    seen.push((JSON.parse(stdout.join("")) as { truncated: unknown }).truncated);
  }
  assert.deepEqual(seen, [true, false, null]);
  assert.equal(new Set(seen).size, 3);
  // The falsy test that does NOT work — asserted so nobody re-adds the claim that it does.
  assert.equal(!seen[1], !seen[2]);
});

test("--limit rejects values the server would silently turn back into the default", async () => {
  // `Number(query.limit) || 50` on the route means `abc` and `0` both become 50. Failing here is
  // the difference between "you got a different page than you asked for" and being told so.
  // 101 and 500 are the OTHER end: the route clamps them to 100, so without this the command
  // would print "shown 100, --limit 500" -- its own verdict line stating a number that was
  // never used. Same defect as the coerced-to-default end, mirrored.
  for (const bad of ["abc", "0", "-1", "2.5", "101", "500"]) {
    const { io } = memoryIo();
    const ctx = createCommandContext({
      io,
      loadAgentContext: () => agentContext,
      createApiClient: () => ({ request: async () => { throw new Error("must not reach the network"); } }) as any,
    });
    await assert.rejects(
      async () => { await mentionPendingCommand.handler(ctx, { json: true, limit: bad }); },
      (error: unknown) => (error as { code?: string }).code === "INVALID_ARG",
      `--limit ${bad} should be rejected locally`,
    );
  }
});
