import assert from "node:assert/strict";

afterEach(() => vi.unstubAllGlobals());

test("analytics initializes and creates events with an unmodified HTTP crypto object", async () => {
  const crypto = Object.freeze({ getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
  vi.stubGlobal("crypto", crypto);
  const analytics = await import("../src/analytics/track");
  try {
    analytics.setProductEventServerIdGetter(() => "test-workspace");
    analytics.trackEvent("community_cn_qr_page_view", { from: "direct" });
    assert.equal("randomUUID" in crypto, false);
  } finally {
    analytics.resetProductEventsForTest();
  }
});
