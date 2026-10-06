import assert from "node:assert/strict";
import { buildRaftProgram } from "../../program";
import type { ApiClient, ApiResponse } from "../../client";
import type { CliIo } from "../../core/io";
import { deliverAgentTokenToProcess } from "./token";

function memoryIo() {
  const stdout: string[] = []; const stderr: string[] = [];
  const io: CliIo = {
    stdout: { write: (value: string | Uint8Array) => { stdout.push(String(value)); return true; } },
    stderr: { write: (value: string | Uint8Array) => { stderr.push(String(value)); return true; } },
  };
  return { io, stdout, stderr };
}
const token = "synthetic-jwt-secret-abcdefghijklmnopqrstuvwxyz-0123456789";
const issued = { access_token: token, audience: "test-rp", expires_in: 300, expires_at: "2026-10-05T01:05:00Z" };

test("JWT process delivery uses FD 3, strips credential environment and redacts split child output", async () => {
  const output = memoryIo();
  const program = `
    const fs = require('node:fs');
    if (process.env.RAFT_INTEGRATION_TOKEN_FD !== '3') process.exit(2);
    for (const key of ['HOME', 'SLOCK_AGENT_PROXY_TOKEN_FILE', 'AWS_SECRET_ACCESS_KEY', 'RAFT_AGENT_TOKEN']) {
      if (process.env[key] !== undefined) process.exit(3);
    }
    const token = fs.readFileSync(3, 'utf8').trim();
    if (!token || process.argv.some(arg => arg.includes(token))) process.exit(4);
    process.stdout.write('received:');
    process.stdout.write(token.slice(0, 20));
    setTimeout(() => { process.stdout.write(token.slice(20) + ':done'); process.stderr.write(token); }, 10);
  `;
  const result = await deliverAgentTokenToProcess({
    program: process.execPath, args: ["-e", program], timeoutMs: 5000,
    env: { PATH: process.env.PATH, HOME: "/private-home", SLOCK_AGENT_PROXY_TOKEN_FILE: "/private-credential", AWS_SECRET_ACCESS_KEY: "cloud-secret", RAFT_AGENT_TOKEN: "agent-secret" },
    io: output.io, issue: async () => issued,
  });
  assert.deepEqual(result, { audience: "test-rp", expiresAt: issued.expires_at });
  assert.equal(output.stdout.join(""), "received:<redacted>:done");
  assert.equal(output.stderr.join(""), "<redacted>");
});

test("JWT process launch failure does not issue a token", async () => {
  let calls = 0;
  await assert.rejects(deliverAgentTokenToProcess({
    program: "/no-such-raft-jwt-receiver", args: [], timeoutMs: 1000, env: {}, io: memoryIo().io,
    issue: async () => { calls++; return issued; },
  }), { code: "PROCESS_START_FAILED" });
  assert.equal(calls, 0);
});

test("JWT issuance failure terminates the waiting receiver and does not print its credential", async () => {
  const output = memoryIo();
  await assert.rejects(deliverAgentTokenToProcess({
    program: process.execPath, args: ["-e", "require('node:fs').readFileSync(3);setInterval(()=>{},1000)"],
    timeoutMs: 1000, env: {}, io: output.io, issue: async () => { throw new Error("issuance-denied"); },
  }), /issuance-denied/);
  assert.equal(output.stdout.join(""), "");
});

test("JWT receiver nonzero exit and timeout are failures rather than successful delivery receipts", async () => {
  await assert.rejects(deliverAgentTokenToProcess({
    program: process.execPath, args: ["-e", "require('node:fs').readFileSync(3);process.exit(7)"],
    timeoutMs: 2000, env: {}, io: memoryIo().io, issue: async () => issued,
  }), { code: "RECEIVER_FAILED" });
  await assert.rejects(deliverAgentTokenToProcess({
    program: process.execPath, args: ["-e", "require('node:fs').readFileSync(3);setInterval(()=>{},1000)"],
    timeoutMs: 100, env: {}, io: memoryIo().io, issue: async () => issued,
  }), { code: "PROCESS_TIMEOUT" });
});


test("integration token parser uses the canonical route and passes receiver arguments without a shell", async () => {
  const output = memoryIo();
  let requests = 0;
  const program = buildRaftProgram({
    io: output.io, env: {},
    loadAgentContext: () => ({ agentId: "agent-fixture", serverId: "server-fixture", serverUrl: "https://raft.test", token: "agent-fixture-secret", clientMode: "self-hosted-runner", secretSource: "profile-credential-file", activeCapabilities: null }),
    createApiClient: () => ({
      request: async <T>(method: string, requestPath: string, body: unknown): Promise<ApiResponse<T>> => {
        requests++;
        assert.equal(method, "POST");
        assert.equal(requestPath, "/internal/agent-api/integrations/token");
        assert.deepEqual(body, { service: "test-rp" });
        return { ok: true, status: 200, error: null, data: { ...issued, token_type: "Bearer" } } as ApiResponse<T>;
      },
    }) as unknown as ApiClient,
  });
  const receiver = "require('node:fs').readFileSync(3);process.stdout.write(process.argv.slice(1).join('|'))";
  await program.parseAsync(["integration", "token", "--service", "test-rp", "--exec", process.execPath, "--", "-e", receiver, "--", "value with spaces", "--literal"], { from: "user" });
  assert.equal(requests, 1);
  assert.equal(output.stdout.join(""), "value with spaces|--literal");
  assert.match(output.stderr.join(""), /Agent JWT delivered for test-rp/);
  assert.equal(output.stderr.join("").includes(token), false);
});

test("JWT timeout aborts an in-flight issuance request and terminates the receiver", async () => {
  let aborted = false;
  await assert.rejects(deliverAgentTokenToProcess({
    program: process.execPath, args: ["-e", "require('node:fs').readFileSync(3);setInterval(()=>{},1000)"],
    timeoutMs: 100, env: {}, io: memoryIo().io,
    issue: async (signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
      aborted = true; reject(new Error("request-aborted"));
    }, { once: true })),
  }), { code: "PROCESS_TIMEOUT" });
  assert.equal(aborted, true);
});
