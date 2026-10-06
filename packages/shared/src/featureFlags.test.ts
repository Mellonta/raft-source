import { strict as assert } from "node:assert";

import {
  isSlackBridgeProductFeatureFlagKey,
  SLACK_BRIDGE_FEATURE_FLAG_KEYS,
  SLACK_BRIDGE_INTERNAL_FEATURE_FLAG_KEYS,
  SLACK_BRIDGE_PRODUCT_FEATURE_FLAG_KEYS,
} from "./featureFlags";

test("Slack Bridge exposes product flags without hidden per-direction fuses", () => {
  assert.deepEqual(Object.values(SLACK_BRIDGE_PRODUCT_FEATURE_FLAG_KEYS), [
    SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
    SLACK_BRIDGE_FEATURE_FLAG_KEYS.attachmentTransfer,
    SLACK_BRIDGE_FEATURE_FLAG_KEYS.reactionSync,
  ]);
  assert.equal(SLACK_BRIDGE_INTERNAL_FEATURE_FLAG_KEYS.length, 0);
  assert.equal(isSlackBridgeProductFeatureFlagKey(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master), true);
  assert.equal(isSlackBridgeProductFeatureFlagKey("unknown"), false);

  const all = new Set(Object.values(SLACK_BRIDGE_FEATURE_FLAG_KEYS));
  const products = Object.values(SLACK_BRIDGE_PRODUCT_FEATURE_FLAG_KEYS);
  const internal = [...SLACK_BRIDGE_INTERNAL_FEATURE_FLAG_KEYS];
  assert.equal(new Set(products).size, products.length);
  assert.equal(new Set(internal).size, internal.length);
  assert.equal(products.some((key) => (internal as readonly string[]).includes(key)), false);
  assert.deepEqual(new Set([...products, ...internal]), all);
  assert.deepEqual(internal, []);
});
