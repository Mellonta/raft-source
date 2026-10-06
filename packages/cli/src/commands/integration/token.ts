import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { Command } from "commander";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import type { CliIo } from "../../core/io";
import { cliError } from "../../core/errors";
import { writeText, writeDiagnostic, NL } from "../../core/renderer";
import { formatIntegrationTokenReceiverOutput, formatIntegrationTokenReceipt } from "./_format";
import { createAgentApiSurfaceClient } from "../../agentApiPath";

type IssuedToken = { access_token: string; audience: string; expires_in: number; expires_at: string };

// Child output can accidentally echo its input. Keep a token-sized tail so
// even a JWT split across chunks is redacted before any bytes reach CLI output.
function redactedWriter(write: (value: string) => void, secret: () => string) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const flush = (final: boolean) => {
    const token = secret();
    if (token) pending = pending.replaceAll(token, "<redacted>");
    const count = final ? pending.length : Math.max(0, pending.length - Math.max(0, token.length - 1));
    if (count > 0) { write(pending.slice(0, count)); pending = pending.slice(count); }
  };
  return {
    data: (chunk: Buffer) => { pending += decoder.write(chunk); flush(false); },
    end: () => { pending += decoder.end(); flush(true); },
  };
}

export async function deliverAgentTokenToProcess(input: {
  program: string; args: string[]; env: NodeJS.ProcessEnv; io: CliIo;
  timeoutMs: number; issue: (signal: AbortSignal) => Promise<IssuedToken>;
}): Promise<{ audience: string; expiresAt: string }> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw cliError("UNSUPPORTED_PLATFORM", "Private JWT process delivery requires Linux or macOS");
  }
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR"]) {
    if (input.env[key] !== undefined) childEnv[key] = input.env[key];
  }
  childEnv.RAFT_INTEGRATION_TOKEN_FD = "3";
  const controller = new AbortController();
  const child = spawn(input.program, input.args, { env: childEnv, shell: false, stdio: ["ignore", "pipe", "pipe", "pipe"] });
  let secret = "";
  const out = redactedWriter((value) => writeText(input.io, formatIntegrationTokenReceiverOutput(value)), () => secret);
  const err = redactedWriter((value) => writeDiagnostic(input.io, formatIntegrationTokenReceiverOutput(value)), () => secret);
  child.stdout!.on("data", out.data);
  child.stderr!.on("data", err.data);
  child.stdout!.on("end", out.end);
  child.stderr!.on("end", err.end);
  let failed = false;
  let abortCode: "PROCESS_TIMEOUT" | "PROCESS_CANCELLED" | null = null;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    controller.abort();
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
    killTimer.unref();
  };
  const cancel = () => { abortCode = "PROCESS_CANCELLED"; stop(); };
  const timer = setTimeout(() => { abortCode = "PROCESS_TIMEOUT"; stop(); }, input.timeoutMs);
  timer.unref();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const closed = new Promise<number | null>((resolve) => {
    child.once("error", () => { failed = true; });
    child.once("close", resolve);
  });
  const pipe = child.stdio[3] as Writable;
  // Handle EPIPE even if the receiving program exits before issuance finishes.
  pipe.on("error", () => { failed = true; stop(); });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => reject(cliError("PROCESS_START_FAILED", "Could not start the JWT receiving program")));
    });
    if (abortCode || controller.signal.aborted) throw cliError(abortCode ?? "PROCESS_CANCELLED", "JWT delivery was cancelled before issuance");
    let issued: IssuedToken;
    try {
      issued = await input.issue(controller.signal);
    } catch (error) {
      if (abortCode) throw cliError(abortCode, "JWT issuance was cancelled or timed out; delivery did not complete");
      throw error;
    }
    secret = issued.access_token;
    if (abortCode || child.exitCode !== null || child.signalCode !== null || failed) {
      throw cliError(abortCode ?? "TOKEN_DELIVERY_FAILED", "JWT was not delivered to a running receiver");
    }
    await new Promise<void>((resolve, reject) => {
      pipe.end(`${secret}\n`, (error?: Error | null) => error
        ? reject(cliError("TOKEN_DELIVERY_FAILED", "Could not deliver JWT to the private process pipe"))
        : resolve());
    });
    const code = await closed;
    if (abortCode) throw cliError(abortCode, "The JWT receiving program was cancelled or timed out");
    if (code !== 0 || failed) throw cliError("RECEIVER_FAILED", "The JWT receiving program did not complete successfully");
    return { audience: issued.audience, expiresAt: issued.expires_at };
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    if (child.exitCode === null && child.signalCode === null && !failed) stop();
    pipe.destroy();
    await closed;
    if (killTimer) clearTimeout(killTimer);
    secret = "";
  }
}

export const integrationTokenCommand = defineCommand({
  name: "token",
  description: "Deliver a five-minute Agent JWT to a child process through private FD 3; never print the token",
  arguments: ["[args...]"],
  options: [
    { flags: "--service <client-key>", description: "Exact registered Server-local client key enabled by the platform operator" },
    { flags: "--exec <program>", description: "Trusted receiving program; read the token from RAFT_INTEGRATION_TOKEN_FD (3)" },
    { flags: "--timeout <seconds>", description: "Receiver deadline, 1–300 seconds (default 300)" },
  ],
  helpAfter: "Pass program arguments after --. The child receives only PATH, locale, timezone, TMPDIR and the FD number; no Raft/cloud credentials or HOME. No shell is used. Child output is forwarded with the issued JWT redacted. This is not a sandbox. Issuance/delivery does not prove service authentication; the child must validate its service response. Supported on Linux/macOS only.",
}, async (ctx, args: string[], opts: { service?: string; exec?: string; timeout?: string }) => {
  const service = opts.service?.trim();
  const program = opts.exec?.trim();
  const seconds = opts.timeout === undefined ? 300 : Number(opts.timeout);
  if (!service || !/^[a-z][a-z0-9-]{2,63}$/.test(service) || !program || !Number.isInteger(seconds) || seconds < 1 || seconds > 300) {
    throw cliError("INVALID_ARG", "--service <client-key> and --exec <program> are required; --timeout must be 1–300 seconds");
  }
  const result = await deliverAgentTokenToProcess({
    program, args, env: ctx.env, io: ctx.io, timeoutMs: seconds * 1000,
    issue: async (signal) => {
      const client = ctx.createApiClient(ctx.loadAgentContext());
      const response = await createAgentApiSurfaceClient(client, { signal }).integrations.token({ service });
      if (!response.ok || !response.data) throw cliError(response.errorCode ?? "AGENT_JWT_FAILED", response.error ?? "Agent JWT issuance failed");
      if (response.data.audience !== service) throw cliError("TOKEN_DELIVERY_FAILED", "Issued JWT audience did not match the requested service");
      return response.data;
    },
  });
  // Metadata goes to stderr to keep the receiver's stdout independently usable.
  writeDiagnostic(ctx.io, formatIntegrationTokenReceipt(result), NL);
});

export function registerIntegrationTokenCommand(parent: Command, options: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, integrationTokenCommand, options);
}
