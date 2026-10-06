import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { createServer } from "node:http";
import {
  createKimiRequestDiagnosticSession,
  KIMI_REQUEST_DIAGNOSTIC_AGENT_ID_ENV,
  KIMI_REQUEST_DIAGNOSTIC_SESSION_ID_ENV,
  type KimiRequestDiagnosticRecord,
} from "./kimiRequestDiagnostics";

const AGENT_ID = "agent-target";
const SESSION_ID = "session-target";

function enabledEnv(): NodeJS.ProcessEnv {
  return {
    [KIMI_REQUEST_DIAGNOSTIC_AGENT_ID_ENV]: AGENT_ID,
    [KIMI_REQUEST_DIAGNOSTIC_SESSION_ID_ENV]: SESSION_ID,
  };
}

function createRecorder(env = enabledEnv()) {
  const records: KimiRequestDiagnosticRecord[] = [];
  let nowMs = 1_000;
  const session = createKimiRequestDiagnosticSession({
    env,
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    emit: (record) => records.push(record),
    now: () => nowMs,
  });
  assert.ok(session);
  session.observeSdkEvent({ type: "turn.step.started", turnId: 7, step: 2 });
  return {
    env,
    records,
    session,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

function publish(name: string, message: unknown): void {
  channel(name).publish(message);
}

test("requires exact agent and session selectors", () => {
  const cases: Array<{ env: NodeJS.ProcessEnv; agentId: string; sessionId: string }> = [
    { env: {}, agentId: AGENT_ID, sessionId: SESSION_ID },
    { env: { [KIMI_REQUEST_DIAGNOSTIC_AGENT_ID_ENV]: AGENT_ID }, agentId: AGENT_ID, sessionId: SESSION_ID },
    { env: enabledEnv(), agentId: "other-agent", sessionId: SESSION_ID },
    { env: enabledEnv(), agentId: AGENT_ID, sessionId: "other-session" },
  ];
  for (const input of cases) {
    assert.equal(createKimiRequestDiagnosticSession({ ...input, emit: () => {} }), null);
  }
});

test("records a successful model request without request content", () => {
  const { records, session, advance } = createRecorder();
  const request = {
    method: "POST",
    path: "/v1/chat/completions?secret=query-sentinel",
    headers: { authorization: "Bearer header-sentinel" },
    body: "prompt-sentinel",
  };

  session.run(() => {
    publish("undici:request:create", { request });
    advance(125);
    publish("undici:request:headers", { request, response: { statusCode: 200 } });
    advance(375);
    publish("undici:request:trailers", { request, trailers: ["secret", "trailer-sentinel"] });
  });

  assert.deepEqual(records, [{
    turnId: "7",
    step: 2,
    outerAttempt: 1,
    innerAttempt: 1,
    correlationId: `${SESSION_ID}:7.2:1.1`,
    outcome: "success",
    durationMs: 500,
    startedAtMs: 1_000,
    finishedAtMs: 1_500,
    statusCode: 200,
  }]);
  const serialized = JSON.stringify(records);
  for (const secret of ["query-sentinel", "header-sentinel", "prompt-sentinel", "trailer-sentinel"]) {
    assert.ok(!serialized.includes(secret));
  }
});

test("keeps the diagnostic context through a real undici request lifecycle", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const { records, session } = createRecorder();

  try {
    const response = await session.run(() => fetch(
      `http://127.0.0.1:${address.port}/v1/chat/completions?private=query`,
      {
        method: "POST",
        headers: { authorization: "Bearer private-token" },
        body: "private-prompt",
      },
    ));
    await response.text();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.outcome, "success");
    assert.equal(records[0]?.statusCode, 200);
    assert.equal(records[0]?.innerAttempt, 1);
    const serialized = JSON.stringify(records);
    for (const secret of ["query", "private-token", "private-prompt"]) {
      assert.ok(!serialized.includes(secret));
    }
  } finally {
    session.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("distinguishes HTTP errors, timeouts, connection failures, and cancellation", () => {
  const { records, session } = createRecorder();
  const cases = [
    {
      request: { method: "POST", path: "/chat/completions" },
      terminalChannel: "undici:request:headers",
      terminalMessage: (request: object) => ({ request, response: { statusCode: 429 } }),
      expected: { outcome: "http_error", statusCode: 429 },
    },
    {
      request: { method: "POST", path: "/chat/completions" },
      terminalChannel: "undici:request:error",
      terminalMessage: (request: object) => ({ request, error: { name: "HeadersTimeoutError", code: "UND_ERR_HEADERS_TIMEOUT", message: "secret-timeout-message" } }),
      expected: { outcome: "connection_timeout", errorClass: "timeout" },
    },
    {
      request: { method: "POST", path: "/chat/completions" },
      terminalChannel: "undici:request:error",
      terminalMessage: (request: object) => ({ request, error: { name: "SocketError", code: "ECONNRESET", message: "secret-connection-message" } }),
      expected: { outcome: "connection_failed", errorClass: "connection" },
    },
    {
      request: { method: "POST", path: "/chat/completions" },
      terminalChannel: "undici:request:error",
      terminalMessage: (request: object) => ({ request, error: { name: "AbortError", code: "UND_ERR_ABORTED", message: "secret-cancel-message" } }),
      expected: { outcome: "cancelled", errorClass: "cancelled" },
    },
  ] as const;

  session.run(() => {
    for (const entry of cases) {
      publish("undici:request:create", { request: entry.request });
      publish(entry.terminalChannel, entry.terminalMessage(entry.request));
    }
  });

  assert.equal(records.length, 4);
  assert.deepEqual(
    records.map(({ outcome, statusCode, errorClass, innerAttempt }) => ({ outcome, statusCode, errorClass, innerAttempt })),
    cases.map((entry, index) => ({ ...entry.expected, statusCode: "statusCode" in entry.expected ? entry.expected.statusCode : undefined, errorClass: "errorClass" in entry.expected ? entry.expected.errorClass : undefined, innerAttempt: index + 1 })),
  );
  assert.ok(!JSON.stringify(records).includes("secret-"));
});

test("correlates outer and inner retries without copying error messages", () => {
  const { records, session } = createRecorder();
  const firstRequest = { method: "POST", path: "/chat/completions" };
  const secondRequest = { method: "POST", path: "/chat/completions" };

  session.run(() => {
    publish("undici:request:create", { request: firstRequest });
    publish("undici:request:error", {
      request: firstRequest,
      error: { name: "ConnectTimeoutError", message: "private-upstream-message" },
    });
  });
  session.observeSdkEvent({
    type: "turn.step.retrying",
    turnId: 7,
    step: 2,
    failedAttempt: 1,
    nextAttempt: 2,
    maxAttempts: 3,
    delayMs: 750,
    errorName: "APIStatusError",
    statusCode: 503,
  });
  session.run(() => publish("undici:request:create", { request: secondRequest }));

  assert.deepEqual(records.map((record) => ({
    outcome: record.outcome,
    outerAttempt: record.outerAttempt,
    innerAttempt: record.innerAttempt,
    correlationId: record.correlationId,
    statusCode: record.statusCode,
  })), [
    {
      outcome: "connection_timeout",
      outerAttempt: 1,
      innerAttempt: 1,
      correlationId: `${SESSION_ID}:7.2:1.1`,
      statusCode: undefined,
    },
    {
      outcome: "outer_retrying",
      outerAttempt: 2,
      innerAttempt: 0,
      correlationId: `${SESSION_ID}:7.2:2.0`,
      statusCode: 503,
    },
  ]);
  assert.ok(!JSON.stringify(records).includes("private-upstream-message"));
});

test("ignores non-model requests and stops immediately after revocation or close", () => {
  const { env, records, session } = createRecorder();
  session.run(() => {
    publish("undici:request:create", { request: { method: "GET", path: "/models" } });
    publish("undici:request:create", { request: { method: "POST", path: "/unrelated" } });
  });
  assert.deepEqual(records, []);

  delete env[KIMI_REQUEST_DIAGNOSTIC_SESSION_ID_ENV];
  session.run(() => {
    const request = { method: "POST", path: "/chat/completions" };
    publish("undici:request:create", { request });
    publish("undici:request:error", { request, error: { code: "ECONNRESET" } });
  });
  assert.deepEqual(records, []);

  env[KIMI_REQUEST_DIAGNOSTIC_SESSION_ID_ENV] = SESSION_ID;
  session.close();
  session.run(() => {
    const request = { method: "POST", path: "/chat/completions" };
    publish("undici:request:create", { request });
    publish("undici:request:trailers", { request });
  });
  assert.deepEqual(records, []);
});
