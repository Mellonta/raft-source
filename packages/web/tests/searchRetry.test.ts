import assert from "node:assert/strict";
import { buildSearchRetryReset } from "../src/components/search/searchRetry";

test("retry clears stale results and enters a fresh loading cycle", () => {
  assert.deepEqual(buildSearchRetryReset(), {
    results: [],
    loading: true,
    loadingMore: false,
    hasMore: false,
    searchError: null,
  });
});
