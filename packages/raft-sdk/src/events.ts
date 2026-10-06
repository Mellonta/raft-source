import { z } from "zod";
import type { AgentApiClient } from "@botiverse/raft-shared/src/agentApiClient";
import type { AgentApiMessageEnvelope } from "@botiverse/raft-shared/src/agentApiMessageContract";

export interface RaftEventsReceiveRequest {
  /** Numeric lower bound (exclusive). "latest" applies no numeric filter; it does not skip queued messages. */
  since?: number | "latest";
  /** Integer 1..200. Server default: 50. */
  limit?: number;
  /**
   * "cursor": the Server does not acknowledge the returned batch until a later
   * receive passes `since` >= this batch's `lastSeenSeq`, so a lost response is
   * received again. With "cursor", always pass the previous `lastSeenSeq` as
   * `since`. Omitted: the Server acknowledges the batch before responding.
   */
  ack?: "cursor";
}

export interface RaftEventAttachment {
  id: string;
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
}

/** External provenance is attribution, never Raft membership or user authority. */
export interface RaftEventExternalMessage {
  schema: "external-message-provenance.v1";
  provider: string;
  workspace_id: string;
  conversation_id: string;
  message_id: string;
  actor_id: string;
  actor_kind: "human" | "guest" | "remote" | "bot" | "unknown";
  projection_id: string;
}

/** A projection of an inbox message, not a general lifecycle event. Missing legacy metadata stays absent. */
export interface RaftEvent {
  type: "message";
  messageId?: string;
  seq?: number;
  content?: string;
  timestamp?: string;
  senderType: "human" | "agent" | "system" | "third_party_app" | "unknown";
  senderName?: string;
  channelId?: string;
  channelName?: string;
  channelType?: string;
  parentChannelName?: string;
  parentChannelType?: string;
  attachments: RaftEventAttachment[];
  externalMessage?: RaftEventExternalMessage;
}

export interface RaftEventsReceiveData {
  events: RaftEvent[];
  lastSeenSeq: number | null;
  lastSeenMessageId: string | null;
  hasMore: boolean;
  /** Send target of the newest event in the batch (`#channel`, `#channel:<8hex>`, `dm:@peer`, `dm:@peer:<8hex>`); not proof of permission to reply. Null for an empty batch. */
  replyTarget: string | null;
  /**
   * How the Server acknowledges this batch: "cursor" (on a later receive whose
   * `since` covers it), "immediate" (already acknowledged), or null when the
   * Server does not say (older Servers acknowledge immediately).
   */
  ackMode: "cursor" | "immediate" | null;
}

export interface RaftEventsReceiveError {
  code: "INVALID_REQUEST" | "TRANSPORT_ERROR" | "HTTP_ERROR" | "INVALID_RESPONSE";
  /** Safe SDK text; raw transport errors and response bodies are never included. */
  message: string;
}

export type RaftEventsReceiveResult =
  | { ok: true; status: number; data: RaftEventsReceiveData }
  | { ok: false; status?: number; error: RaftEventsReceiveError };

const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const requestSchema = z.object({
  since: z.union([sequence, z.literal("latest")]).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  ack: z.literal("cursor").optional(),
}).strict();

// The shared contract validates the message envelope and external provenance.
// These additional fields are currently passthrough there; validate before exporting them.
const metadataSchema = z.object({
  seq: sequence.optional(),
  channel_id: z.string().optional(),
  channelId: z.string().optional(),
  attachments: z.array(z.object({
    id: z.string(), filename: z.string(), mimeType: z.string().optional(),
    sizeBytes: sequence.optional(),
  })).optional(),
});

function projectMessage(message: AgentApiMessageEnvelope): RaftEvent {
  const metadata = metadataSchema.parse(message);
  const sender = message.sender_type ?? message.senderType;
  const senderType = sender === "human" || sender === "agent" || sender === "system" || sender === "third_party_app"
    ? sender : "unknown";
  return {
    type: "message",
    messageId: message.message_id ?? message.id,
    seq: metadata.seq,
    content: message.content,
    timestamp: message.timestamp ?? message.createdAt,
    senderType,
    senderName: message.sender_name ?? message.senderName,
    channelId: metadata.channel_id ?? metadata.channelId,
    channelName: message.channel_name,
    channelType: message.channel_type,
    parentChannelName: message.parent_channel_name,
    parentChannelType: message.parent_channel_type,
    attachments: metadata.attachments ?? [],
    externalMessage: message.external_message,
  };
}

function failure(code: RaftEventsReceiveError["code"], status?: number, cursorAck = false): RaftEventsReceiveResult {
  const ackNote = cursorAck
    ? "The batch was not acknowledged; receiving again with the same since returns it again"
    : "Delivery acknowledgement may already have occurred";
  const messages: Record<RaftEventsReceiveError["code"], string> = {
    INVALID_REQUEST: "Receive requires a nonnegative safe integer or latest cursor, an integer limit from 1 to 200, and ack omitted or \"cursor\".",
    TRANSPORT_ERROR: `Event receive transport failed. ${ackNote}; no retry was attempted.`,
    HTTP_ERROR: `Event receive returned an HTTP error. ${ackNote}; no retry was attempted.`,
    INVALID_RESPONSE: `Event receive response did not match the SDK contract. ${ackNote}; no retry was attempted.`,
  };
  return { ok: false, ...(status === undefined ? {} : { status }), error: { code, message: messages[code] } };
}

/** Internal adapter. The caller must supply a single-attempt transport: receive drains the returned batch. */
export async function receiveRaftEvents(
  client: Pick<AgentApiClient, "events">,
  request: RaftEventsReceiveRequest = {},
): Promise<RaftEventsReceiveResult> {
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success) return failure("INVALID_REQUEST");
  const cursorAck = parsed.data.ack === "cursor";
  const result = await client.events.get({
    ...(parsed.data.since === undefined ? {} : { since: String(parsed.data.since) }),
    ...(parsed.data.limit === undefined ? {} : { limit: String(parsed.data.limit) }),
    ...(cursorAck ? { ack: "cursor" as const } : {}),
  });
  if (!result.ok) {
    return failure(result.error.kind === "transport" ? "TRANSPORT_ERROR"
      : result.error.kind === "http" ? "HTTP_ERROR" : "INVALID_RESPONSE", result.status, cursorAck);
  }
  try {
    return { ok: true, status: result.status, data: {
      events: result.data.events.map(projectMessage),
      lastSeenSeq: sequence.nullable().parse(result.data.last_seen_seq),
      lastSeenMessageId: result.data.last_seen_msgId,
      hasMore: result.data.has_more,
      replyTarget: result.data.reply_target,
      ackMode: result.data.ack_mode ?? null,
    } };
  } catch {
    // Parsing failed after the Server answered. In cursor mode the Server may
    // have acknowledged nothing new, but the caller cannot read the cursor.
    return failure("INVALID_RESPONSE", result.status, cursorAck);
  }
}
