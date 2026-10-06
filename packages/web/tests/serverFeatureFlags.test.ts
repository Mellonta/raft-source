import assert from "node:assert/strict";
import "./helpers/domSetup";

import {
  CHANNEL_MANAGER_ROLE_ACTIONS_FEATURE_FLAG_KEY,
  PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
  SLACK_BRIDGE_FEATURE_FLAG_KEYS,
} from "@botiverse/raft-shared";
import api from "../src/api/client";
import { connectSocket, getSocket, resetSocket } from "../src/api/socket";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import {
  ACTIVITY_SIDEBAR_INBOX_FLAG_KEY,
  ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY,
  REGISTERED_SERVER_FEATURE_FLAG_KEYS,
  getServerFeatureFlagSnapshot,
  prefetchServerFeatureFlags,
  publishServerFeatureFlagValuesFromLabsReadback,
  readServerFeatureFlag,
  readServerFeatureFlagState,
  refreshServerFeatureFlags,
  resetServerFeatureFlagsForTests,
  setServerFeatureFlagForTests,
  setServerFeatureFlagRetryBackoffForTests,
} from "../src/store/serverFeatureFlags";

const originalPost = api.post.bind(api);
const originalAuthState = useAuthStore.getState();
const originalServerState = useServerStore.getState();

test("provider connections are registered and fail closed before server evaluation", () => {
  assert.ok(REGISTERED_SERVER_FEATURE_FLAG_KEYS.includes(PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY));
  assert.equal(readServerFeatureFlag("server-a", PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY), false);
});

test("flag state distinguishes loading from a resolved disabled result", async () => {
  assert.equal(
    readServerFeatureFlagState("server-a", ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY),
    "loading",
  );
  api.post = (async () => ({ data: { evaluations: [] } })) as typeof api.post;

  await prefetchServerFeatureFlags("server-a");

  assert.equal(
    readServerFeatureFlagState("server-a", ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY),
    "disabled",
  );
});

test("channel-manager role actions are registered and fail closed before server evaluation", () => {
  assert.ok(REGISTERED_SERVER_FEATURE_FLAG_KEYS.includes(CHANNEL_MANAGER_ROLE_ACTIONS_FEATURE_FLAG_KEY));
  assert.equal(readServerFeatureFlag("server-a", CHANNEL_MANAGER_ROLE_ACTIONS_FEATURE_FLAG_KEY), false);
});

test("Slack Bridge master gate is registered and fail-closed before server evaluation", () => {
  assert.ok(REGISTERED_SERVER_FEATURE_FLAG_KEYS.includes(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master));
  assert.equal(readServerFeatureFlag("server-a", SLACK_BRIDGE_FEATURE_FLAG_KEYS.master), false);
});

test("Activity sidebar inbox is registered and fail closed before server evaluation", () => {
  assert.ok(REGISTERED_SERVER_FEATURE_FLAG_KEYS.includes(ACTIVITY_SIDEBAR_INBOX_FLAG_KEY));
  assert.equal(readServerFeatureFlag("server-a", ACTIVITY_SIDEBAR_INBOX_FLAG_KEY), false);
});

afterEach(() => {
  api.post = originalPost as typeof api.post;
  resetSocket();
  resetServerFeatureFlagsForTests();
  useAuthStore.setState(originalAuthState, true);
  useServerStore.setState(originalServerState, true);
  localStorage.clear();
});

test("registered server flags evaluate once as one batch and repeated consumers reuse the result", async () => {
  let postCalls = 0;
  api.post = (async (url: string, body?: unknown) => {
    postCalls += 1;
    assert.equal(url, "/feature-flags/evaluate");
    assert.deepEqual(body, {
      serverId: "server-a",
      platform: "web",
      keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
    });
    return {
      data: {
        evaluations: REGISTERED_SERVER_FEATURE_FLAG_KEYS.map((key) => ({
          key,
          enabled: key === ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY,
        })),
      },
    };
  }) as typeof api.post;

  for (let index = 0; index < 100; index += 1) {
    assert.equal(
      readServerFeatureFlag("server-a", ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY),
      false,
      "message consumers stay fail-closed while the one batch is pending",
    );
  }
  assert.equal(postCalls, 0, "message-time reads must never own feature-flag I/O");

  const [first, second] = await Promise.all([
    prefetchServerFeatureFlags("server-a"),
    prefetchServerFeatureFlags("server-a"),
  ]);
  const third = await prefetchServerFeatureFlags("server-a");

  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(postCalls, 1);
  assert.equal(first.resolved, true);
  assert.equal(first.values[ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY], true);
  assert.equal(
    readServerFeatureFlagState("server-a", ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY),
    "enabled",
  );
  assert.equal(
    getServerFeatureFlagSnapshot("server-a").values[ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY],
    true,
  );
  for (let index = 0; index < 100; index += 1) {
    assert.equal(
      readServerFeatureFlag("server-a", ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY),
      true,
      "new message consumers read the resolved cache without another request",
    );
  }
  assert.equal(postCalls, 1);
});

test("transient batch evaluate failures retry once before resolving the server cache", async () => {
  setServerFeatureFlagRetryBackoffForTests(0);
  let postCalls = 0;
  api.post = (async (url: string, body?: unknown) => {
    postCalls += 1;
    assert.equal(url, "/feature-flags/evaluate");
    assert.deepEqual(body, {
      serverId: "server-a",
      platform: "web",
      keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
    });
    if (postCalls === 1) throw new Error("transient feature flag failure");
    return {
      data: {
        evaluations: [{ key: ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY, enabled: true }],
      },
    };
  }) as typeof api.post;

  const [first, second] = await Promise.all([
    prefetchServerFeatureFlags("server-a"),
    prefetchServerFeatureFlags("server-a"),
  ]);
  const third = await prefetchServerFeatureFlags("server-a");

  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(postCalls, 2);
  assert.equal(first.resolved, true);
  assert.equal(first.values[ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY], true);
  assert.equal(
    readServerFeatureFlag("server-a", ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY),
    true,
    "one transient failure must not pin registered flags false for the session",
  );
});

test("retry backoff does not re-evaluate after the session cache is invalidated", async () => {
  setServerFeatureFlagRetryBackoffForTests(0);
  let postCalls = 0;
  api.post = (async () => {
    postCalls += 1;
    throw new Error("feature flag service unavailable before logout");
  }) as typeof api.post;

  const request = prefetchServerFeatureFlags("server-a");
  resetServerFeatureFlagsForTests();
  const snapshot = await request;

  assert.equal(postCalls, 1);
  assert.equal(snapshot.resolved, true);
  for (const key of REGISTERED_SERVER_FEATURE_FLAG_KEYS) {
    assert.equal(snapshot.values[key], false);
  }
  assert.equal(
    getServerFeatureFlagSnapshot("server-a").resolved,
    false,
    "stale retry completion must not publish into the new session generation",
  );
});

test("server flag cache is scoped per server and repeated request failures resolve fail-closed", async () => {
  setServerFeatureFlagRetryBackoffForTests(0);
  const requestedServers: string[] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  api.post = (async (_url: string, body?: unknown) => {
    const serverId = (body as { serverId: string }).serverId;
    requestedServers.push(serverId);
    if (serverId === "server-b") throw new Error("feature flag service unavailable");
    return {
      data: {
        evaluations: [{ key: ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY, enabled: true }],
      },
    };
  }) as typeof api.post;

  const serverA = await prefetchServerFeatureFlags("server-a");
  const serverB = await prefetchServerFeatureFlags("server-b");
  await prefetchServerFeatureFlags("server-a");
  await prefetchServerFeatureFlags("server-b");

  assert.deepEqual(requestedServers, ["server-a", "server-b", "server-b"]);
  assert.equal(serverA.values[ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY], true);
  assert.equal(serverB.resolved, true);
  assert.equal(serverB.resolution, "undetermined");
  assert.equal(
    readServerFeatureFlagState("server-b", ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY),
    "undetermined",
    "a terminal evaluation failure must not masquerade as a disabled flag",
  );
  assert.equal(
    readServerFeatureFlag("server-b", ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY),
    false,
    "undetermined flags remain fail-closed for existing boolean consumers",
  );
  for (const key of REGISTERED_SERVER_FEATURE_FLAG_KEYS) {
    assert.equal(serverB.values[key], false);
  }
  assert.equal(warn.mock.calls.length, 1);
  assert.match(String(warn.mock.calls[0][0]), /evaluation failed/);
  assert.deepEqual(warn.mock.calls[0][1], { serverId: "server-b" });
});

test("Lab readback stays determinate when the batch evaluator is undetermined", async () => {
  setServerFeatureFlagRetryBackoffForTests(0);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  api.post = (async () => {
    throw new Error("feature flag service unavailable");
  }) as typeof api.post;

  await prefetchServerFeatureFlags("server-a");
  publishServerFeatureFlagValuesFromLabsReadback({
    serverId: "server-a",
    serverLabVersion: 1,
    masterEnabled: true,
    labs: [{
      key: ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY,
      name: "Attachment comments",
      description: "Attachment comments.",
      state: "open",
      enrolled: true,
      effective: true,
    }],
  });

  assert.equal(
    readServerFeatureFlagState("server-a", ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY),
    "enabled",
  );
  assert.equal(
    readServerFeatureFlagState("server-a", PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY),
    "undetermined",
  );
});

test("Lab readback stays determinate while the batch evaluator is still loading", () => {
  publishServerFeatureFlagValuesFromLabsReadback({
    serverId: "server-enabled",
    serverLabVersion: 1,
    masterEnabled: true,
    labs: [{
      key: ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY,
      name: "Attachment comments",
      description: "Attachment comments.",
      state: "open",
      enrolled: true,
      effective: true,
    }],
  });
  publishServerFeatureFlagValuesFromLabsReadback({
    serverId: "server-disabled",
    serverLabVersion: 1,
    masterEnabled: true,
    labs: [{
      key: ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY,
      name: "Attachment comments",
      description: "Attachment comments.",
      state: "open",
      enrolled: false,
      effective: false,
    }],
  });

  assert.equal(
    readServerFeatureFlagState("server-enabled", ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY),
    "enabled",
  );
  assert.equal(
    readServerFeatureFlagState("server-disabled", ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY),
    "disabled",
  );
  assert.equal(
    readServerFeatureFlagState("server-enabled", PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY),
    "loading",
  );
});

test("Lab readback-derived flag values win over slower evaluator responses", async () => {
  let postCalls = 0;
  api.post = (async (url: string, body?: unknown) => {
    postCalls += 1;
    assert.equal(url, "/feature-flags/evaluate");
    const request = body as { serverId: string; keys: string[] };
    assert.equal(request.serverId, "server-a");
    return {
      data: {
        evaluations: request.keys.map((key) => ({
          key,
          enabled: false,
        })),
      },
    };
  }) as typeof api.post;

  await prefetchServerFeatureFlags("server-a");
  publishServerFeatureFlagValuesFromLabsReadback({
    serverId: "server-a",
    serverLabVersion: 3,
    masterEnabled: true,
    labs: [{
      key: ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY,
      name: "Attachment comments",
      description: "Attachment comments.",
      state: "open",
      enrolled: true,
      effective: true,
    }],
  });

  assert.equal(readServerFeatureFlag("server-a", ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY), true);

  await refreshServerFeatureFlags("server-a");

  assert.equal(postCalls, 2);
  assert.equal(
    readServerFeatureFlag("server-a", ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY),
    true,
    "a delayed evaluator refresh must not resurrect the older Lab gate result",
  );
  assert.equal(
    readServerFeatureFlagState("server-a", ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY),
    "enabled",
    "the Lab-derived state stays authoritative after batch evaluation resolves",
  );
});

test("socket lifecycle prefetches the registered server flags", async () => {
  useServerStore.setState({
    current: {
      id: "server-socket-flags",
      name: "Socket Flags",
      slug: "socket-flags",
      avatarUrl: null,
      ownerId: "owner-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: new Date(0).toISOString(),
    },
  } as never);
  let postCalls = 0;
  api.post = (async (url: string, body?: unknown) => {
    postCalls += 1;
    assert.equal(url, "/feature-flags/evaluate");
    assert.deepEqual(body, {
      serverId: "server-socket-flags",
      platform: "web",
      keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
    });
    return { data: { evaluations: [] } };
  }) as typeof api.post;

  const socket = getSocket();
  vi.spyOn(socket, "connect").mockImplementation(() => socket);
  connectSocket();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(postCalls, 1, "the explicit connect path owns one registry prefetch");

  resetServerFeatureFlagsForTests();
  postCalls = 0;
  const connected = socket.listeners("connect");
  assert.equal(connected.length, 1, "connectSocket installs one connect lifecycle listener");
  connected[0]?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(postCalls, 1, "the successful socket lifecycle refreshes the registry cache");
});

test("logout invalidates the resolved server feature-flag session cache", () => {
  setServerFeatureFlagForTests(
    "server-before-logout",
    ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY,
    true,
  );
  assert.equal(getServerFeatureFlagSnapshot("server-before-logout").resolved, true);
  assert.equal(
    readServerFeatureFlag("server-before-logout", ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY),
    true,
  );
  useAuthStore.setState({
    user: { id: "user-before-logout" } as never,
    accessToken: "access-before-logout",
    refreshToken: null,
    initialized: true,
  });

  useAuthStore.getState().logout();

  assert.equal(
    getServerFeatureFlagSnapshot("server-before-logout").resolved,
    false,
    "a new login must not inherit the previous session's evaluated flags",
  );
});
