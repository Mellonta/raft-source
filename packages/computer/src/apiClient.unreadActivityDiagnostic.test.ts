import assert from "node:assert/strict";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";

import { UnreadActivityDiagnosticClient } from "./apiClient";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";

async function withMockAgent(
  setup: (pool: ReturnType<MockAgent["get"]>) => void,
  run: () => Promise<void>,
): Promise<void> {
  const previous = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  setup(agent.get("https://api.test"));
  try {
    await run();
  } finally {
    setGlobalDispatcher(previous);
    await agent.close();
  }
}

test("diagnostic client uses only the current session and optional server membership target", async () => {
  await withMockAgent(
    (pool) => {
      pool.intercept({
        path: `/api/diagnostics/unread-activity?serverId=${SERVER_ID}`,
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: "Bearer session-token",
        },
      }).reply(200, {
        schema_version: "unread-activity-diagnostic.v1",
        diagnostic_correlation_id: "opaque-server-token",
      });
    },
    async () => {
      assert.deepEqual(
        await new UnreadActivityDiagnosticClient("https://api.test", "session-token").get(SERVER_ID),
        {
          status: "success",
          snapshot: {
            schema_version: "unread-activity-diagnostic.v1",
            diagnostic_correlation_id: "opaque-server-token",
          },
        },
      );
    },
  );
});

test("diagnostic client omits serverId for the bounded all-memberships snapshot", async () => {
  await withMockAgent(
    (pool) => {
      pool.intercept({ path: "/api/diagnostics/unread-activity", method: "GET" }).reply(200, {
        schema_version: "unread-activity-diagnostic.v1",
      });
    },
    async () => {
      const result = await new UnreadActivityDiagnosticClient("https://api.test", "session-token").get();
      assert.equal(result.status, "success");
    },
  );
});

test("diagnostic client maps auth, membership, transport, and malformed responses without server detail", async () => {
  for (const [statusCode, expected] of [
    [401, { status: "auth_required" }],
    [403, { status: "forbidden" }],
    [503, { status: "error", code: "http_503" }],
  ] as const) {
    await withMockAgent(
      (pool) => {
        pool.intercept({ path: "/api/diagnostics/unread-activity", method: "GET" }).reply(statusCode, {
          error: "private server detail",
          token: "must-not-escape",
        });
      },
      async () => {
        assert.deepEqual(
          await new UnreadActivityDiagnosticClient("https://api.test", "session-token").get(),
          expected,
        );
      },
    );
  }

  for (const response of ["null", "[]", '"not-an-object"', "42"]) {
    await withMockAgent(
      (pool) => {
        pool.intercept({ path: "/api/diagnostics/unread-activity", method: "GET" }).reply(200, response, {
          headers: { "content-type": "application/json" },
        });
      },
      async () => {
        assert.deepEqual(
          await new UnreadActivityDiagnosticClient("https://api.test", "session-token").get(),
          { status: "error", code: "unexpected_shape" },
        );
      },
    );
  }

  await withMockAgent(
    () => undefined,
    async () => {
      assert.deepEqual(
        await new UnreadActivityDiagnosticClient("https://api.test", "session-token").get(),
        { status: "error", code: "request_failed" },
      );
    },
  );
});
