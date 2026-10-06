import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { completeSimple, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  PROVIDER_PROBE_REPLY_MAX_BYTES,
  providerProbeAuthorityIdentity,
  providerProbeResultDigest,
  sha256Hex,
  utf8ByteLength,
} from "@botiverse/raft-shared";
import {
  buildProviderProbeResultMessage,
  claimProbeMaterialization,
  buildUnclaimedProviderProbeResult,
  classifyProbeFailure,
  runProviderProbeCanary,
  type ProbeMaterialization,
} from "./providerProbe";
import { permitRealNetworkInThisFile } from "./testing/networkGuard";

permitRealNetworkInThisFile("the probe aims at an unroutable address on purpose to classify connect timeouts", ["10.255.255.1"]);

test("classifyProbeFailure maps provider errors onto the closed category set", () => {
  assert.equal(classifyProbeFailure("HTTP 401 Unauthorized"), "auth");
  assert.equal(classifyProbeFailure("invalid api key"), "auth");
  assert.equal(classifyProbeFailure("429 rate limit exceeded"), "rate_quota");
  assert.equal(classifyProbeFailure("404 model not found"), "model");
  assert.equal(classifyProbeFailure("getaddrinfo ENOTFOUND api.example.com"), "dns_tls");
  assert.equal(classifyProbeFailure("unable to verify TLS certificate"), "dns_tls");
  assert.equal(classifyProbeFailure("connect ECONNREFUSED 127.0.0.1:443"), "network");
  assert.equal(classifyProbeFailure("something unclassifiable"), "invalid_response");
});

test("the canary rejects incomplete projections without touching the network", async () => {
  const materialization: ProbeMaterialization = {
    envVars: {},
    providerConnection: { providerId: "deepseek", endpointUrl: null, supportsImageInput: false },
    authority: { connectionEpochId: "e", replicaGeneration: "g" },
  };
  const result = await runProviderProbeCanary({ materialization, model: "deepseek-chat" });
  assert.equal(result.outcome, "failure");
  assert.equal(result.category, "model");
  assert.equal(result.reply, null);
});

test("the real pi-ai adapter returns a bounded assistant reply through the faux provider", async () => {
  const registration = registerFauxProvider({
    api: "faux-probe",
    provider: "fauxprobe",
    models: [{ id: "faux-1" }],
  });
  try {
    registration.setResponses([{
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
      api: "faux-probe",
      provider: "fauxprobe",
      model: "faux-1",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    }]);
    const assistant = await completeSimple(
      registration.getModel(),
      { messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }] },
      { apiKey: "faux-key", maxTokens: 1 },
    );
    assert.equal(assistant.stopReason, "stop");
    const text = assistant.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");
    assert.equal(text, "OK");
    assert.ok(utf8ByteLength(text) <= PROVIDER_PROBE_REPLY_MAX_BYTES);
  } finally {
    registration.unregister();
  }
});

test("gateway canary classifies unreachable endpoints as provider_timeout on budget abort", async () => {
  const materialization: ProbeMaterialization = {
    envVars: { OPENAI_API_KEY: "probe-key" },
    providerConnection: {
      providerId: "openai-compatible",
      endpointUrl: "http://10.255.255.1:9999",
      supportsImageInput: false,
    },
    authority: { connectionEpochId: "e", replicaGeneration: "g" },
  };
  const result = await runProviderProbeCanary({ materialization, model: "faux-model", budgetMs: 400 });
  assert.equal(result.outcome, "failure");
  assert.ok(
    result.category === "provider_timeout" || result.category === "network",
    `unexpected category ${result.category}`,
  );
  assert.equal(result.reply, null);
  assert.equal(result.responseSha256, null);
  assert.equal(result.responseBytes, null);
});

test("the result message chains the digest over closed fields and never the reply", async () => {
  const authority = { connectionEpochId: "epoch-1", replicaGeneration: "gen-1" };
  const reply = "OK";
  const message = await buildProviderProbeResultMessage({
    requestId: "req-1",
    probeId: "probe-1" as never,
    execution: {
      outcome: "success",
      category: null,
      latencyMs: 7,
      responseSha256: await sha256Hex(reply),
      responseBytes: utf8ByteLength(reply),
      reply,
    },
    authority,
    daemonVersion: "daemon-1",
    computerVersion: "computer-1",
    runtimeVersion: "pi-1",
  });
  assert.equal(message.reply, reply);
  assert.equal(message.daemonVersion, "daemon-1");
  assert.equal(message.runtimeVersion, "pi-1");
  assert.equal(message.resultDigest, await providerProbeResultDigest({
    outcome: "success",
    category: null,
    responseSha256: await sha256Hex(reply),
    responseBytes: utf8ByteLength(reply),
    authorityIdentity: await providerProbeAuthorityIdentity(authority),
  }));
  assert.equal(message.resultDigest.includes(reply), false);
  assert.deepEqual(message.authorityEcho, authority);

  // Failure results carry no reply/hash/bytes on the wire (closed shape).
  const failure = await buildProviderProbeResultMessage({
    requestId: "req-1b",
    probeId: "probe-1" as never,
    execution: {
      outcome: "failure",
      category: "auth",
      latencyMs: 3,
      responseSha256: "deadbeef",
      responseBytes: 4,
      reply: null,
    },
    authority,
    daemonVersion: null,
    computerVersion: null,
    runtimeVersion: null,
  });
  assert.equal(failure.reply, null);
  assert.equal(failure.responseSha256, null);
  assert.equal(failure.responseBytes, null);

  // A carrier that could not claim authority sends category null; the Server
  // closes such results as invalid_carrier_result through its own receipt path.
  const unclaimed = await buildUnclaimedProviderProbeResult({ requestId: "req-2", probeId: "probe-2" as never });
  assert.equal(unclaimed.outcome, "failure");
  assert.equal(unclaimed.category, null);
  assert.equal(unclaimed.reply, null);
  assert.equal(unclaimed.responseSha256, null);
  assert.equal(unclaimed.responseBytes, null);
});

test("the reply bound is enforced in UTF-8 bytes and rejects blanks", async () => {
  const { boundProviderProbeReply } = await import("@botiverse/raft-shared");
  assert.equal(boundProviderProbeReply(""), null);
  assert.equal(boundProviderProbeReply("   "), null);
  assert.equal(boundProviderProbeReply(null), null);
  assert.equal(boundProviderProbeReply(42), null);
  const tooLong = "a".repeat(PROVIDER_PROBE_REPLY_MAX_BYTES + 1);
  assert.equal(utf8ByteLength(tooLong), PROVIDER_PROBE_REPLY_MAX_BYTES + 1);
  assert.equal(boundProviderProbeReply(tooLong), null);
  const multibyte = "中".repeat(Math.floor(PROVIDER_PROBE_REPLY_MAX_BYTES / 3));
  assert.ok(utf8ByteLength(multibyte) > PROVIDER_PROBE_REPLY_MAX_BYTES / 3);
  assert.equal(boundProviderProbeReply("OK"), "OK");
});

test("claimProbeMaterialization accepts the three-key envelope over HTTP and rejects two-key bodies", async () => {
  const envelope = {
    authority: { connectionEpochId: "epoch-http", replicaGeneration: "gen-http" },
    envVars: { OPENAI_API_KEY: "http-key" },
    providerConnection: {
      providerId: "openai-compatible",
      endpointUrl: "https://gateway.example.com/v1",
      supportsImageInput: false,
    },
  };
  const withAuthority = createHttpServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(envelope));
  });
  await new Promise<void>((resolve) => withAuthority.listen(0, resolve));
  const withAuthorityPort = (withAuthority.address() as AddressInfo).port;
  try {
    const materialization = await claimProbeMaterialization({
      serverUrl: `http://127.0.0.1:${withAuthorityPort}`,
      daemonApiKey: "daemon-key",
      probeId: "probe-http" as never,
      claimRequestId: "claim-http",
    });
    assert.deepEqual(materialization.authority, envelope.authority);
    assert.equal(materialization.envVars.OPENAI_API_KEY, "http-key");
    assert.equal(materialization.providerConnection.endpointUrl, "https://gateway.example.com/v1");
  } finally {
    withAuthority.close();
  }

  const twoKey = createHttpServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ envVars: envelope.envVars, providerConnection: envelope.providerConnection }));
  });
  await new Promise<void>((resolve) => twoKey.listen(0, resolve));
  const twoKeyPort = (twoKey.address() as AddressInfo).port;
  try {
    await assert.rejects(
      claimProbeMaterialization({
        serverUrl: `http://127.0.0.1:${twoKeyPort}`,
        daemonApiKey: "daemon-key",
        probeId: "probe-http" as never,
        claimRequestId: "claim-http",
      }),
      /invalid payload/,
    );
  } finally {
    twoKey.close();
  }
});

test("the production canary path succeeds through the real pi-ai adapter without ambient env", async () => {
  const registration = registerFauxProvider({
    api: "openai-completions",
    provider: "fauxcanary",
    models: [{ id: "faux-canary" }],
  });
  registration.setResponses([{
    role: "assistant",
    content: [{ type: "text", text: "OK" }],
    api: "openai-completions",
    provider: "fauxcanary",
    model: "faux-canary",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  }]);
  try {
    const materialization = {
      envVars: { OPENAI_API_KEY: "faux-key" },
      providerConnection: {
        providerId: "openai-compatible" as const,
        endpointUrl: "https://unused.example/v1",
        supportsImageInput: false,
      },
      authority: { connectionEpochId: "e", replicaGeneration: "g" },
    };
    const result = await runProviderProbeCanary({ materialization, model: "faux-canary" });
    assert.equal(result.outcome, "success");
    assert.equal(result.reply, "OK");
    assert.equal(result.responseBytes, 2);

    // No ambient env pickup: an unrelated key name must not authenticate the
    // canary, so the run fails closed instead of reaching the provider.
    const noAmbient = await runProviderProbeCanary({
      materialization: { ...materialization, envVars: { DEEPSEEK_API_KEY: "ambient" } },
      model: "faux-canary",
    });
    assert.equal(noAmbient.outcome, "failure");
    assert.equal(noAmbient.category, "model");
  } finally {
    registration.unregister();
  }
});

test("the claim budget cuts a slow materialize endpoint", async () => {
  const slow = createHttpServer((_req, res) => {
    setTimeout(() => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        authority: { connectionEpochId: "e", replicaGeneration: "g" },
        envVars: { OPENAI_API_KEY: "k" },
        providerConnection: { providerId: "openai-compatible", endpointUrl: "https://gw.example.com/v1", supportsImageInput: false },
      }));
    }, 6_000);
  });
  await new Promise<void>((resolve) => slow.listen(0, resolve));
  const port = (slow.address() as AddressInfo).port;
  const started = Date.now();
  try {
    await assert.rejects(
      claimProbeMaterialization({
        serverUrl: `http://127.0.0.1:${port}`,
        daemonApiKey: "daemon-key",
        probeId: "probe-slow" as never,
        claimRequestId: "claim-slow",
      }),
    );
    assert.ok(Date.now() - started < 6_000, "the claim must abort before the slow endpoint answers");
  } finally {
    slow.close();
  }
});
