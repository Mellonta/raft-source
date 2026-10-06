import assert from "node:assert/strict";

import { normalizeReactionEmoji } from "./react";

test("normalizeReactionEmoji trims a single reaction token", () => {
  assert.equal(normalizeReactionEmoji(" 👀 "), "👀");
});

test("normalizeReactionEmoji rejects empty or multi-token reactions", () => {
  assert.throws(() => normalizeReactionEmoji("   "), /single reaction emoji/);
  assert.throws(() => normalizeReactionEmoji("👍 ❤️"), /single reaction emoji/);
});
