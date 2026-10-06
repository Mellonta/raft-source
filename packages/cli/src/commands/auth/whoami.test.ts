import assert from "node:assert/strict";

import { whoamiCommand } from "./whoami";
import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import { CliError } from "../../core/errors";
import type { CliIo } from "../../core/io";

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
  activeCapabilities: ["knowledge"],
  profileSlug: "demo",
  profileCredentialPath: "/tmp/demo/credential.json",
};

const localData = {
  agentId: "agent-1",
  serverUrl: "https://slock.example",
  serverId: "server-1",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  profileSlug: "demo",
  profileCredentialPath: "/tmp/demo/credential.json",
};

function contextBody(overrides: { agentId?: string; prompt?: { audience: "self-hosted-runner"; text: string } | null } = {}) {
  return {
    agent: { id: overrides.agentId ?? "agent-1", name: "alice", displayName: "Alice", description: "Reviewer", runtime: "external", external: true },
    server: { id: "server-1", slug: "acme", name: "Acme" },
    credential: { capabilities: ["read", "send"] },
    prompt: overrides.prompt === undefined ? { audience: "self-hosted-runner" as const, text: "# Raft CLI operating guide\n\nYou are \"Alice\"" } : overrides.prompt,
  };
}

function contextWith(io: CliIo, respond: () => Promise<ApiResponse<unknown>>, requests: string[] = []) {
  return createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string) => {
        requests.push(`${method} ${path}`);
        return respond();
      },
    }) as never,
  });
}

test("whoami prints local context plus the server-confirmed identity and redacts the token", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: string[] = [];
  const ctx = contextWith(io, async () => ({ ok: true, status: 200, error: null, data: contextBody() }), requests);

  await whoamiCommand.handler(ctx, {});

  assert.deepEqual(requests, ["GET /internal/agent-api/context"]);
  assert.deepEqual(stderr, []);
  const payload = JSON.parse(stdout.join(""));
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.data, {
    ...localData,
    serverConfirmed: true,
    agent: contextBody().agent,
    server: { id: "server-1", slug: "acme", name: "Acme" },
    capabilities: ["read", "send"],
  });
  assert.equal(stdout.join("").includes("secret-token"), false);
});

test("whoami on network failure prints the local context as unconfirmed and fails explicitly", async () => {
  const { io, stdout } = memoryIo();
  const ctx = contextWith(io, async () => {
    throw new TypeError("fetch failed");
  });

  await assert.rejects(async () => whoamiCommand.handler(ctx, {}), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.match(err.message, /Could not confirm identity with the server/);
    assert.match(err.message, /unconfirmed/);
    return true;
  });
  const payload = JSON.parse(stdout.join(""));
  assert.equal(payload.ok, false);
  assert.deepEqual(payload.data, { ...localData, serverConfirmed: false });
  assert.equal(stdout.join("").includes("secret-token"), false);
});

test("whoami on an HTTP failure carries the server's error code", async () => {
  const { io } = memoryIo();
  const ctx = contextWith(io, async () => ({ ok: false, status: 401, error: "Invalid agent credential", errorCode: "invalid_credential", data: null }));

  await assert.rejects(async () => whoamiCommand.handler(ctx, {}), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.code, "invalid_credential");
    assert.match(err.message, /Invalid agent credential/);
    return true;
  });
});

test("whoami refuses to confirm when the server names a different agent", async () => {
  const { io } = memoryIo();
  const ctx = contextWith(io, async () => ({ ok: true, status: 200, error: null, data: contextBody({ agentId: "agent-2" }) }));

  await assert.rejects(async () => whoamiCommand.handler(ctx, {}), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.code, "IDENTITY_MISMATCH");
    return true;
  });
});

test("whoami --prompt prints the server-rendered guide verbatim", async () => {
  const { io, stdout, stderr } = memoryIo();
  const ctx = contextWith(io, async () => ({ ok: true, status: 200, error: null, data: contextBody() }));

  await whoamiCommand.handler(ctx, { prompt: true });

  assert.deepEqual(stderr, []);
  assert.equal(stdout.join(""), "# Raft CLI operating guide\n\nYou are \"Alice\"\n");
});

test("whoami --prompt fails explicitly for a managed agent (no server-rendered prompt)", async () => {
  const { io, stdout } = memoryIo();
  const ctx = contextWith(io, async () => ({ ok: true, status: 200, error: null, data: contextBody({ prompt: null }) }));

  await assert.rejects(async () => whoamiCommand.handler(ctx, { prompt: true }), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.code, "PROMPT_UNAVAILABLE");
    return true;
  });
  assert.deepEqual(stdout, []);
});
