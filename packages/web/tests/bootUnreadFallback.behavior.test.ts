import assert from "node:assert/strict";

import {
  __setBootUnreadFallbackMsForTests,
  buildMainLayoutSocketBindings,
  createMainLayoutRealtimeBridgeDriver,
} from "../src/store/socketBridge";
import type {
  MainLayoutRealtimeTransport,
  SocketBinding,
} from "../src/store/socketBridge";
import { useChannelStore } from "../src/store/channelStore";
import { useInboxStore } from "../src/store/inboxStore";
import { useMessageStore } from "../src/store/messageStore";
import { useAgentStore } from "../src/store/agentStore";
import { useMachineStore } from "../src/store/machineStore";

/**
 * Boot unread/inbox ownership: rooms:joined is the authority; the bootstrap
 * only arms a bounded fallback so an offline boot (no rooms:joined) still
 * loads exactly once. Healthy boot must not double-fetch the pair.
 */

const SERIAL = {};

function fakeTransport(): MainLayoutRealtimeTransport {
  return {
    reconnectSocket: () => undefined,
    ensureSocketConnected: () => undefined,
    isSocketConnected: () => true,
  };
}

function countLoaders() {
  const calls = { unread: 0, inbox: 0 };
  const saved = {
    unread: useMessageStore.getState().loadUnreadCounts,
    inbox: useInboxStore.getState().loadInbox,
  };
  useMessageStore.setState({ loadUnreadCounts: async () => { calls.unread += 1; } } as never);
  useInboxStore.setState({ loadInbox: async () => { calls.inbox += 1; } } as never);
  useChannelStore.setState({
    loadChannels: async () => undefined,
    loadDMChannels: async () => undefined,
  } as never);
  return {
    calls,
    restore() {
      useMessageStore.setState({ loadUnreadCounts: saved.unread } as never);
      useInboxStore.setState({ loadInbox: saved.inbox } as never);
    },
  };
}

function roomsJoinedHandler() {
  const bindings = buildMainLayoutSocketBindings(
    { on: () => undefined, emit: () => undefined } as never,
    () => undefined,
    async () => undefined,
    () => undefined,
    () => undefined,
  );
  const handler = bindings.find((b: SocketBinding) => b.event === "rooms:joined")?.handler;
  assert.ok(handler, "rooms:joined binding exists");
  return handler;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("healthy boot: rooms:joined owns the unread/inbox load and the fallback never fires", SERIAL, async () => {
  const restoreDelay = __setBootUnreadFallbackMsForTests(40);
  const probe = countLoaders();
  try {
    const driver = createMainLayoutRealtimeBridgeDriver(fakeTransport());
    driver.bootstrap();
    roomsJoinedHandler()();
    await wait(120);
    assert.equal(probe.calls.unread, 1, "rooms:joined issues the only unread-counts load");
    assert.equal(probe.calls.inbox, 1, "rooms:joined issues the only inbox load");
  } finally {
    probe.restore();
    restoreDelay();
  }
});

test("offline boot (no rooms:joined): the armed fallback loads unread/inbox exactly once", SERIAL, async () => {
  const restoreDelay = __setBootUnreadFallbackMsForTests(40);
  const probe = countLoaders();
  try {
    const driver = createMainLayoutRealtimeBridgeDriver(fakeTransport());
    driver.bootstrap();
    await wait(0);
    assert.equal(probe.calls.unread, 0, "bootstrap must not fetch inline — it only arms the fallback");
    assert.equal(probe.calls.inbox, 0, "bootstrap must not reset the inbox inline");
    await wait(120);
    assert.equal(probe.calls.unread, 1, "fallback fires exactly one unread-counts load");
    assert.equal(probe.calls.inbox, 1, "fallback fires exactly one inbox load");
  } finally {
    probe.restore();
    restoreDelay();
  }
});

/**
 * Connect-snapshot ownership: the connect snapshot owns agents / machines /
 * followed threads; a boot whose socket never connects (a proxy blocking
 * WebSockets) must still load them once, and a connect cancels the fallback.
 */
function countSnapshotLoaders() {
  const calls = { agents: 0, machines: 0 };
  const savedAgents = useAgentStore.getState().loadAgents;
  const savedMachines = useMachineStore.getState().loadMachines;
  useAgentStore.setState({ loadAgents: async () => { calls.agents += 1; } } as never);
  useMachineStore.setState({ loadMachines: async () => { calls.machines += 1; } } as never);
  return {
    calls,
    restore() {
      useAgentStore.setState({ loadAgents: savedAgents } as never);
      useMachineStore.setState({ loadMachines: savedMachines } as never);
    },
  };
}

function connectHandler() {
  const bindings = buildMainLayoutSocketBindings(
    { on: () => undefined, emit: () => undefined } as never,
    () => undefined,
    async () => undefined,
    () => undefined,
    () => undefined,
  );
  const handler = bindings.find((b: SocketBinding) => b.event === "connect")?.handler;
  assert.ok(handler, "connect binding exists");
  return handler;
}

test("socket never connects: the boot fallback loads the agent roster exactly once", SERIAL, async () => {
  const restoreDelay = __setBootUnreadFallbackMsForTests(40);
  const probe = countLoaders();
  const snapshot = countSnapshotLoaders();
  try {
    const driver = createMainLayoutRealtimeBridgeDriver(fakeTransport());
    driver.bootstrap();
    await wait(120);
    assert.equal(snapshot.calls.agents, 1, "the fallback loads agents once");
    assert.equal(snapshot.calls.machines, 1, "the fallback loads machines once");
  } finally {
    snapshot.restore();
    probe.restore();
    restoreDelay();
  }
});

test("healthy boot: the connect snapshot owns the roster load and the fallback never fires", SERIAL, async () => {
  const restoreDelay = __setBootUnreadFallbackMsForTests(40);
  const probe = countLoaders();
  const snapshot = countSnapshotLoaders();
  try {
    const driver = createMainLayoutRealtimeBridgeDriver(fakeTransport());
    driver.bootstrap();
    connectHandler()();
    await wait(120);
    assert.equal(snapshot.calls.agents, 1, "connect issues the only agents load");
    assert.equal(snapshot.calls.machines, 1, "connect issues the only machines load");
  } finally {
    snapshot.restore();
    probe.restore();
    restoreDelay();
  }
});
