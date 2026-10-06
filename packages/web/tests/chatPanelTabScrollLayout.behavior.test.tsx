import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("ChatPanel ConversationPanelBody wrappers have flex flex-col to support scrolling", () => {
  const filePath = resolve(import.meta.dirname, "../src/components/message/ChatPanel.tsx");
  const content = readFileSync(filePath, "utf-8");

  // Verify that TasksPanel and ChannelFilesPanel are wrapped in ConversationPanelBody with flex flex-col
  assert.match(
    content,
    /<ConversationPanelBody className="flex flex-col"><TasksPanel channelId=\{channel\.id\} \/><\/ConversationPanelBody>/,
    "TasksPanel must be wrapped in ConversationPanelBody with flex flex-col",
  );
  assert.match(
    content,
    /<ConversationPanelBody className="flex flex-col"><ChannelFilesPanel channel=\{channel\} \/><\/ConversationPanelBody>/,
    "ChannelFilesPanel must be wrapped in ConversationPanelBody with flex flex-col",
  );
});
