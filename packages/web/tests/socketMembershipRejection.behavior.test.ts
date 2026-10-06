import "./helpers/domSetup";

import assert from "node:assert/strict";
import type { NavigateFunction } from "react-router-dom";
import { SOCKET_NOT_SERVER_MEMBER_ERROR } from "@botiverse/raft-shared";
import { buildMainLayoutSocketBindings, setMainLayoutBridgeNavigate } from "../src/store/socketBridge";
import type { MainLayoutSocketBridgeSocket } from "../src/store/socketBridge";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";

const server: Server = {
  id: "server-1",
  name: "Design",
  avatarUrl: null,
  slug: "design",
  ownerId: "owner-1",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "free",
  planDowngradedAt: null,
  role: "member",
  createdAt: "2026-07-25T00:00:00.000Z",
};

const socket = {
  connected: false,
  emit: () => undefined,
  on: () => undefined,
  off: () => undefined,
  onAny: () => undefined,
  offAny: () => undefined,
  disconnect: () => undefined,
  connect: () => undefined,
} as unknown as MainLayoutSocketBridgeSocket;

afterEach(() => {
  setMainLayoutBridgeNavigate(null);
  useServerStore.setState(useServerStore.getInitialState(), true);
  localStorage.clear();
});

function connectErrorHandler() {
  const bindings = buildMainLayoutSocketBindings(
    socket,
    () => undefined,
    async () => undefined,
    () => undefined,
    () => undefined,
  );
  const binding = bindings.find((candidate) => candidate.event === "connect_error");
  assert.ok(binding, "missing connect_error binding");
  return binding.handler;
}

function captureNavigation() {
  const navigations: string[] = [];
  setMainLayoutBridgeNavigate(((to: string) => {
    navigations.push(to);
  }) as NavigateFunction);
  return navigations;
}

test("a not-a-member handshake rejection leaves the current server without the membership event", async () => {
  // The membership-removed emit is lost once revocation closes the socket, so
  // the handshake rejection is the only signal the client receives.
  const removals: string[] = [];
  useServerStore.setState({
    current: server,
    handleMembershipRemoved: async (serverId) => {
      removals.push(serverId);
      return true;
    },
  });
  const navigations = captureNavigation();

  connectErrorHandler()(new Error(SOCKET_NOT_SERVER_MEMBER_ERROR));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(removals, ["server-1"]);
  assert.deepEqual(navigations, ["/"]);
});

test("other handshake rejections do not touch membership", async () => {
  const removals: string[] = [];
  useServerStore.setState({
    current: server,
    handleMembershipRemoved: async (serverId) => {
      removals.push(serverId);
      return true;
    },
  });
  const navigations = captureNavigation();

  const handler = connectErrorHandler();
  handler(new Error("Invalid or expired token"));
  handler(new Error("Authentication changed; reconnect required"));
  handler(new Error("timeout"));
  handler(undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(removals, []);
  assert.deepEqual(navigations, []);
});

test("a rejection the membership re-read contradicts keeps the user on the server", async () => {
  // handleMembershipRemoved re-reads the server list; if the user is still a
  // member there (for example a stale rejection), nothing navigates.
  useServerStore.setState({
    current: server,
    handleMembershipRemoved: async () => false,
  });
  const navigations = captureNavigation();

  connectErrorHandler()(new Error(SOCKET_NOT_SERVER_MEMBER_ERROR));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(navigations, []);
});

test("a rejection with no current server is ignored", async () => {
  const removals: string[] = [];
  useServerStore.setState({
    current: null,
    handleMembershipRemoved: async (serverId) => {
      removals.push(serverId);
      return true;
    },
  });

  connectErrorHandler()(new Error(SOCKET_NOT_SERVER_MEMBER_ERROR));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(removals, []);
});
