import type { ExternalActorKind } from "@botiverse/raft-shared";
import type { IntlShape } from "react-intl";
import type { MessageId } from "../../i18n/messages";

export const EXTERNAL_ACTOR_KIND_MESSAGE_IDS: Record<ExternalActorKind, MessageId> = {
  human: "message.externalIdentity.kind.human",
  guest: "message.externalIdentity.kind.guest",
  remote: "message.externalIdentity.kind.remote",
  bot: "message.externalIdentity.kind.bot",
  unknown: "message.externalIdentity.kind.unknown",
};

export function formatExternalProviderLabel(
  provider: string | null | undefined,
  formatMessage: IntlShape["formatMessage"],
): string | null {
  const normalized = provider?.trim();
  if (!normalized) return null;
  if (normalized.toLowerCase() === "slack") {
    return formatMessage({ id: "message.externalIdentity.provider.slack" });
  }
  return normalized;
}
