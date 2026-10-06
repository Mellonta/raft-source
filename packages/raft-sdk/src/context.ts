import { z } from "zod";
import type { AgentApiClient } from "@botiverse/raft-shared/src/agentApiClient";

/** The bound External Agent. */
export interface RaftContextAgent {
  id: string;
  name: string;
  displayName: string | null;
  description: string | null;
  runtime: string;
  external: boolean;
}

/** The single Server the credential is bound to. */
export interface RaftContextServer {
  id: string;
  slug: string;
  name: string;
}

export interface RaftContextData {
  agent: RaftContextAgent;
  server: RaftContextServer;
  /** Capabilities granted to this credential, for example `send` or `read`. */
  capabilities: string[];
  /** The rendered operating guide for External Agents; null for daemon-managed agents. */
  guide: string | null;
}

export interface RaftContextError {
  code: "TRANSPORT_ERROR" | "HTTP_ERROR" | "INVALID_RESPONSE";
  /** Safe SDK text; raw transport errors and response bodies are never included. */
  message: string;
}

export type RaftContextResult =
  | { ok: true; status: number; data: RaftContextData }
  | { ok: false; status?: number; error: RaftContextError };

// The shared contract validates the wire shape and allows extra keys; this
// projection exports only documented fields.
const projection = z.object({
  agent: z.object({
    id: z.string(),
    name: z.string(),
    displayName: z.string().nullable(),
    description: z.string().nullable(),
    runtime: z.string(),
    external: z.boolean(),
  }),
  server: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
  credential: z.object({ capabilities: z.array(z.string()) }),
  prompt: z.object({ text: z.string() }).nullable(),
});

function failure(code: RaftContextError["code"], status?: number): RaftContextResult {
  const messages: Record<RaftContextError["code"], string> = {
    TRANSPORT_ERROR: "Agent context transport failed.",
    HTTP_ERROR: "Agent context returned an HTTP error.",
    INVALID_RESPONSE: "Agent context response did not match the SDK contract.",
  };
  return { ok: false, ...(status === undefined ? {} : { status }), error: { code, message: messages[code] } };
}

/** Internal adapter for `client.agent.context()`. Read-only; safe to retry. */
export async function getRaftContext(client: Pick<AgentApiClient, "agent">): Promise<RaftContextResult> {
  const result = await client.agent.context();
  if (!result.ok) {
    return failure(result.error.kind === "transport" ? "TRANSPORT_ERROR"
      : result.error.kind === "http" ? "HTTP_ERROR" : "INVALID_RESPONSE", result.status);
  }
  const parsed = projection.safeParse(result.data);
  if (!parsed.success) return failure("INVALID_RESPONSE", result.status);
  const { agent, server, credential, prompt } = parsed.data;
  return {
    ok: true,
    status: result.status,
    data: {
      agent: { ...agent },
      server: { ...server },
      capabilities: [...credential.capabilities],
      guide: prompt?.text ?? null,
    },
  };
}
