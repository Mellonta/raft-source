import assert from "node:assert/strict";
import { randomUuid } from "./randomUuid";

afterEach(() => vi.unstubAllGlobals());

test("generates UUID v4 without randomUUID or modifying the browser crypto object", () => {
  let calls = 0;
  const crypto = Object.freeze({
    getRandomValues(this: unknown, bytes: Uint8Array) {
      assert.equal(this, crypto);
      assert.equal(bytes.length, 16);
      bytes.fill(calls++ === 0 ? 0xff : 0);
      return bytes;
    },
  });
  vi.stubGlobal("crypto", crypto);
  assert.equal(randomUuid(), "ffffffff-ffff-4fff-bfff-ffffffffffff");
  assert.equal(randomUuid(), "00000000-0000-4000-8000-000000000000");
  assert.equal(calls, 2);
  assert.equal("randomUUID" in crypto, false);
});

test("fails if secure entropy fails, with no weak random fallback", () => {
  vi.stubGlobal("crypto", {
    getRandomValues() { throw new Error("entropy unavailable"); },
  });
  assert.throws(randomUuid, /entropy unavailable/);
});
