import { sql, type SQL } from "drizzle-orm";
import { messageMentions, messages } from "../db/schema";
import { SYSTEM_MESSAGE_BORN_READ_CLASSIFICATION } from "./systemMessageBornReadRegistry";

/**
 * THE rule for "is this persisted message unread for this receiver", on the
 * application side. It is the per-row half of the unified inbox chain's unread
 * predicate (rw_inbox_normal_v4, infra/risingwave/sql/063-unified-inbox-chain.sql):
 *
 *   NOT (sender = receiver)
 *   AND NOT COALESCE(message_type = 'system' AND causal_actor = receiver, FALSE)
 *   AND (system_subtype IS NULL OR system_subtype NOT IN <noise subtypes>)
 *
 * (the read cursor / join boundary half lives in the chain and read positions).
 *
 * Every transport that hands a message to a receiver must agree with it: live
 * agent delivery (managed `agent:deliver` and the external inbox signal that
 * drives the notice push), the inbox fact rows, and the external pull. A message
 * the inbox considers born-read for a receiver (it caused it: "@X joined / was
 * added" by X itself) or noise must never wake that receiver or appear in its
 * notice, because its pull (`/events`) will never return it.
 */

/**
 * System subtypes that are never unread for anyone: exactly the `skip`
 * producers of the born-read registry (no inbox fact recorded). Derived, so a
 * new skip producer joins the rule automatically; the chain SQL's literal list
 * is pinned against this by inboxUnreadEligibility.test.ts.
 */
export const INBOX_NOISE_SYSTEM_SUBTYPES: readonly string[] = Object.entries(SYSTEM_MESSAGE_BORN_READ_CLASSIFICATION)
  .filter(([, classification]) => classification === "skip")
  .map(([producer]) => producer)
  .sort();

export type InboxReceiver = { type: "user" | "agent"; id: string };

/** The message columns the rule reads (a `messages` row satisfies it). */
export type InboxEligibilityMessage = {
  senderType: string;
  senderId: string;
  messageType?: "chat" | "system" | null;
  causalActorType?: string | null;
  causalActorId?: string | null;
  systemSubtype?: string | null;
};

export function isMessageUnreadEligibleForReceiver(
  message: InboxEligibilityMessage,
  receiver: InboxReceiver,
  opts: {
    /**
     * The receiver holds a notifiable personal mention on this message. The
     * chain's mention arm (rw_inbox_mention_v6) counts it unread regardless of
     * the born-read / noise exclusions, so they do not apply to it.
     */
    personallyMentioned?: boolean;
  } = {},
): boolean {
  if (message.senderType === receiver.type && message.senderId === receiver.id) return false;
  if (opts.personallyMentioned) return true;
  // NULL causal actor / message type means no exclusion applies (chain NULL rule).
  if (
    message.messageType === "system"
    && message.causalActorType === receiver.type
    && message.causalActorId === receiver.id
  ) return false;
  if (message.systemSubtype != null && INBOX_NOISE_SYSTEM_SUBTYPES.includes(message.systemSubtype)) return false;
  return true;
}

/** The same rule as a SQL condition over `messages` (Postgres reads). */
export function messageUnreadEligibleForReceiverSql(receiver: InboxReceiver): SQL {
  return sql`(NOT (${messages.senderType} = ${receiver.type} AND ${messages.senderId} = ${receiver.id})
    AND (
      EXISTS (
        SELECT 1 FROM ${messageMentions}
        WHERE ${messageMentions.messageId} = ${messages.id}
          AND ${messageMentions.targetType} = ${receiver.type} AND ${messageMentions.targetId} = ${receiver.id}
          AND (${messageMentions.notifiableAtSend} OR ${messageMentions.notifiedAt} IS NOT NULL)
      )
      OR (
        NOT COALESCE(${messages.messageType} = 'system' AND ${messages.causalActorType} = ${receiver.type} AND ${messages.causalActorId} = ${receiver.id}, FALSE)
        AND (${messages.systemSubtype} IS NULL OR ${messages.systemSubtype} NOT IN (${sql.join(INBOX_NOISE_SYSTEM_SUBTYPES.map((subtype) => sql`${subtype}`), sql`, `)}))
      )
    ))`;
}
