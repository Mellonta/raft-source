import assert from "node:assert/strict";
import { installBrowserUuidCompatibility } from "../src/utils/browserCrypto";

afterEach(() => vi.unstubAllGlobals());

test("third-party compatibility is bundled and keeps native UUID implementations", () => {
  const native = () => "native";
  const crypto = { randomUUID: native };
  vi.stubGlobal("crypto", crypto);
  installBrowserUuidCompatibility();
  assert.equal(crypto.randomUUID, native);
});

test("third-party compatibility delegates to secure entropy without recursive UUID calls", () => {
  const crypto = {
    getRandomValues(bytes: Uint8Array) { bytes.fill(0xff); return bytes; },
    randomUUID: undefined as undefined | (() => string),
  };
  vi.stubGlobal("crypto", crypto);
  installBrowserUuidCompatibility();
  assert.equal(crypto.randomUUID?.(), "ffffffff-ffff-4fff-bfff-ffffffffffff");
  installBrowserUuidCompatibility();
  assert.equal(crypto.randomUUID?.(), "ffffffff-ffff-4fff-bfff-ffffffffffff");
});

test("analytics can initialize and create events before any browser compatibility patch", async () => {
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
