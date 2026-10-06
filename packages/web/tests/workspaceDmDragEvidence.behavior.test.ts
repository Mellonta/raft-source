import assert from "node:assert/strict";

import { withWorkspaceDmDragEvidence } from "./e2e/fixtures/workspaceDmDragEvidence";

type Listener = (...args: unknown[]) => void;

class FakePage {
  readonly handlers = new Map<string, Set<Listener>>();
  stopped = false;
  disposed = false;

  async evaluateHandle() {
    return {
      evaluate: async () => {
        this.stopped = true;
        return [];
      },
      dispose: async () => {
        this.disposed = true;
      },
    };
  }

  on(name: string, listener: Listener) {
    const listeners = this.handlers.get(name) ?? new Set<Listener>();
    listeners.add(listener);
    this.handlers.set(name, listeners);
  }

  off(name: string, listener: Listener) {
    this.handlers.get(name)?.delete(listener);
  }

  emit(name: string, ...args: unknown[]) {
    for (const listener of this.handlers.get(name) ?? []) listener(...args);
  }

  get listenerCount() {
    let count = 0;
    for (const listeners of this.handlers.values()) count += listeners.size;
    return count;
  }
}

function makePatchRequest() {
  return {
    method: () => "PATCH",
    url: () => "http://localhost/api/servers/server/sidebar-order",
    postDataJSON: () => ({ dmOrder: ["b", "a"] }),
    failure: () => null,
  };
}

function makeTestInfo(attach: (name: string, attachment: { body: Buffer }) => Promise<void>) {
  return { retry: 0, attach };
}

test("workspace DM drag evidence preserves action error when attachment fails", async () => {
  const page = new FakePage();
  const original = new Error("original PATCH wait failed");
  const testInfo = makeTestInfo(async () => {
    assert.equal(page.stopped, true);
    throw new Error("attachment disk failed");
  });

  const caught = await withWorkspaceDmDragEvidence(
    page as never,
    testInfo as never,
    "server",
    ["a", "b"],
    async () => {
      throw original;
    },
  ).catch(error => error);

  assert.equal(caught, original);
  assert.equal(page.stopped, true);
  assert.equal(page.disposed, true);
  assert.equal(page.listenerCount, 0);
});

test("workspace DM drag evidence preserves action return value when attachment fails", async () => {
  const page = new FakePage();
  const testInfo = makeTestInfo(async () => {
    assert.equal(page.stopped, true);
    throw new Error("attachment disk failed");
  });

  const result = await withWorkspaceDmDragEvidence(
    page as never,
    testInfo as never,
    "server",
    ["a", "b"],
    async () => "action-result",
  );

  assert.equal(result, "action-result");
  assert.equal(page.stopped, true);
  assert.equal(page.disposed, true);
  assert.equal(page.listenerCount, 0);
});

test("workspace DM drag evidence bounds unfinished response body capture", async () => {
  const page = new FakePage();
  const original = new Error("original PATCH wait failed");
  let attachment: unknown;
  const testInfo = makeTestInfo(async (_name, attached) => {
    assert.equal(page.stopped, true);
    attachment = JSON.parse(attached.body.toString("utf8"));
  });
  const request = makePatchRequest();
  const response = {
    request: () => request,
    status: () => 200,
    json: () => new Promise<unknown>(() => undefined),
  };

  const caught = await Promise.race([
    withWorkspaceDmDragEvidence(
      page as never,
      testInfo as never,
      "server",
      ["a", "b"],
      async () => {
        page.emit("request", request);
        page.emit("response", response);
        throw original;
      },
    ).catch(error => error),
    new Promise(resolve => setTimeout(() => resolve("timed-out"), 1_000)),
  ]);

  assert.equal(caught, original);
  assert.equal(page.stopped, true);
  assert.equal(page.disposed, true);
  assert.equal(page.listenerCount, 0);
  assert.deepEqual(attachment, {
    retry: 0,
    dmIds: ["a", "b"],
    events: [],
    patches: [{
      at: (attachment as { patches: Array<{ at: number }> }).patches[0].at,
      payload: { dmOrder: ["b", "a"] },
      status: 200,
      responseUnavailable: true,
    }],
  });
});
