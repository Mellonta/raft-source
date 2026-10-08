import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../public/browser-crypto-bootstrap.js", import.meta.url), "utf8");

test("HTTP bootstrap supplies RFC 4122 v4 UUIDs using the browser entropy source", () => {
  let calls = 0;
  const crypto = {
    getRandomValues(this: unknown, bytes: Uint8Array) {
      assert.equal(this, crypto);
      assert.equal(bytes.length, 16);
      bytes.fill(calls++ === 0 ? 0xff : 0);
      return bytes;
    },
    randomUUID: undefined as undefined | (() => string),
  };
  vm.runInNewContext(source, { crypto });
  assert.equal(crypto.randomUUID?.(), "ffffffff-ffff-4fff-bfff-ffffffffffff");
  assert.equal(crypto.randomUUID?.(), "00000000-0000-4000-8000-000000000000");
  assert.equal(calls, 2);
});

test("HTTPS retains the native UUID implementation", () => {
  const native = () => "native";
  const crypto = { randomUUID: native };
  vm.runInNewContext(source, { crypto });
  assert.equal(crypto.randomUUID, native);
});

test("entropy failure propagates instead of falling back to a weak random source", () => {
  const crypto = {
    getRandomValues() { throw new Error("entropy unavailable"); },
    randomUUID: undefined as undefined | (() => string),
  };
  vm.runInNewContext(source, { crypto });
  assert.throws(() => crypto.randomUUID?.(), /entropy unavailable/);
});
