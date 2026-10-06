import assert from "node:assert/strict";

import api from "../src/api/client";
import {
  describeMessageReactionCommand,
  executeMessageReactionCommand,
} from "../src/store/reactionCommandFacade";

test("typed reaction facade maps set-interaction to the existing HTTP transport", async () => {
  const command = describeMessageReactionCommand({
    serverId: "server-a",
    messageId: "message-a",
    emoji: "👍",
    active: false,
  });
  assert.deepEqual(command, {
    kind: "set-interaction",
    target: { kind: "message", serverId: "server-a", id: "message-a" },
    interaction: "reaction",
    value: { emoji: "👍", active: false },
  });

  const response = { id: "message-a", channelId: "channel-a", reactions: [] };
  const request = vi.spyOn(api, "request").mockImplementation(async () => ({ data: response }));
  assert.equal(await executeMessageReactionCommand(command), response);
  assert.deepEqual(request.mock.calls[0][0], {
    method: "delete",
    url: "/messages/message-a/reactions",
    data: { emoji: "👍" },
  });
});
