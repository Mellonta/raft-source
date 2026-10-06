import type { ParsedRaftPermalink } from "@botiverse/raft-shared";

export function buildMessageContextRequestConfig(channelId: string | null | undefined) {
  return channelId ? { params: { channelId } } : undefined;
}

export function buildMessageContextRequest(messageId: string, channelId: string | null | undefined) {
  return {
    url: `/messages/context/${messageId}`,
    config: buildMessageContextRequestConfig(channelId),
  };
}

// The thread panel renders only the parent message, so it asks for no
// surrounding window (the default is 15 on each side, ~100KB on busy channels).
export function buildThreadParentContextRequest(parentMessageId: string, parentChannelId: string) {
  return {
    url: `/messages/context/${parentMessageId}`,
    config: { params: { channelId: parentChannelId, before: 0, after: 0 } },
  };
}

export function buildQuotedMessageContextRequest(channelId: ParsedRaftPermalink["channelId"]) {
  return buildMessageContextRequestConfig(channelId);
}
