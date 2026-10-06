import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";

import { createSseStreamRegistry } from "./sseStreamRegistry";

/**
 * SSE streams never finish on their own, so without the registry
 * `server.close()` would hang on them until the shutdown deadline severed
 * them mid-stream (task #261). The registry is what lets the going-away
 * phase end them deliberately. These tests pin the two failure modes:
 * double-ending a stream, and ending one that was never registered.
 */

function fakeResponse() {
  let ended = false;
  const res = {
    get writableEnded() {
      return ended;
    },
    end() {
      ended = true;
    },
  } as unknown as ServerResponse;
  return { res, ended: () => ended };
}

test("endAll ends every registered stream exactly once and clears the registry", () => {
  const registry = createSseStreamRegistry();
  const a = fakeResponse();
  const b = fakeResponse();
  registry.register(a.res);
  registry.register(b.res);
  assert.equal(registry.size, 2);

  assert.equal(registry.endAll(), 2);
  assert.equal(a.ended(), true);
  assert.equal(b.ended(), true);
  assert.equal(registry.size, 0);

  // A second endAll is a no-op, not a double end().
  assert.equal(registry.endAll(), 0);
  assert.equal(a.ended(), true);
});

test("unregister removes a stream so endAll leaves it alone", () => {
  const registry = createSseStreamRegistry();
  const a = fakeResponse();
  const b = fakeResponse();
  registry.register(a.res);
  registry.register(b.res);
  registry.unregister(a.res);

  assert.equal(registry.endAll(), 1);
  assert.equal(a.ended(), false);
  assert.equal(b.ended(), true);
});

test("endAll tolerates a stream the client already ended", () => {
  const registry = createSseStreamRegistry();
  const a = fakeResponse();
  registry.register(a.res);
  a.res.end();

  assert.equal(registry.endAll(), 1);
  assert.equal(a.ended(), true);
});
