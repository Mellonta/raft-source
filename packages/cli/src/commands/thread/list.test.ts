import assert from "node:assert/strict";

import type { AgentApiThreadListItem } from "@botiverse/raft-shared";

import type { AgentContext } from "../../auth/env";
import { ApiClient, type ApiResponse } from "../../client";
import { createCommandContext } from "../../core/context";
import type { CliIo } from "../../core/io";
import {
  formatThreadList,
  threadListCommand,
} from "./list";

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

const followedThread: AgentApiThreadListItem = {
  target: "#engineering:abcd1234",
  threadChannelId: "11111111-2222-4333-8444-555555555555",
  parentChannelRef: "#engineering",
  parentMessageId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  parentMessageShortId: "abcd1234",
  followedAt: "2026-09-10T12:00:00.000Z",
  reason: "mentioned",
  doneAt: null,
};

class StubApiClient extends ApiClient {
  constructor(
    private readonly requests: Array<{ method: string; path: string; body?: unknown }>,
    private readonly response: ApiResponse<unknown>,
  ) {
    super(agentContext);
  }

  override async request<T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
    this.requests.push({ method, path, body });
    return this.response as ApiResponse<T>;
  }
}

test("formatThreadList prints an empty state", () => {
  assert.equal(formatThreadList([]), "No followed threads.");
});

test("formatThreadList prints exact unfollow targets", () => {
  assert.equal(
    formatThreadList([followedThread]),
    "Followed threads (1):\n"
      + "- #engineering:abcd1234 (11111111-2222-4333-8444-555555555555, parent=#engineering, followedAt=2026-09-10T12:00:00.000Z, reason=mentioned)",
  );
});

test("thread list command uses injected ApiClient and writes the list", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => new StubApiClient(requests, {
      ok: true,
      status: 200,
      error: null,
      data: { threads: [followedThread] },
    }),
  });

  await threadListCommand.handler(ctx, {});

  assert.deepEqual(requests, [
    {
      method: "GET",
      path: "/internal/agent-api/threads",
      body: undefined,
    },
  ]);
  assert.deepEqual(stderr, []);
  assert.equal(stdout.join(""), `${formatThreadList([followedThread])}\n`);
});
