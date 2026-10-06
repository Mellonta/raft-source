import assert from "node:assert/strict";
import "./helpers/domSetup";

const localStorageValues = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => localStorageValues.get(key) ?? null,
  setItem: (key: string, value: string) => void localStorageValues.set(key, value),
  removeItem: (key: string) => void localStorageValues.delete(key),
  clear: () => localStorageValues.clear(),
  key: () => null,
  length: 0,
} as Storage;
const currentLocalStorage =
  (globalThis as unknown as { localStorage?: Partial<Storage> }).localStorage;
if (typeof currentLocalStorage?.getItem !== "function") {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorageStub,
  });
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolveWait) => setTimeout(resolveWait, 0));
    }
  }
  throw lastError;
}

function makeMainLayoutSocket() {
  type Handler = (...args: unknown[]) => void;
  const handlers = new Map<string, Set<Handler>>();
  const anyHandlers = new Set<Handler>();
  const socket = {
    on(event: string, handler: Handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    off(event: string, handler: Handler) {
      handlers.get(event)?.delete(handler);
    },
    onAny(handler: Handler) {
      anyHandlers.add(handler);
    },
    offAny(handler: Handler) {
      anyHandlers.delete(handler);
    },
  };
  return {
    socket,
    fire(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
      for (const handler of anyHandlers) handler(event, payload);
    },
  };
}

test("loadChannels coalesces concurrent triggers onto one request", async () => {
  const api = (await import("../src/api/client")).default;
  const { useChannelStore } = await import("../src/store/channelStore");
  const { useServerStore } = await import("../src/store/serverStore");
  let channelFetches = 0;
  vi.spyOn(api, "get").mockImplementation(async (url: string) => {
    if (url === "/channels") {
      channelFetches += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      return { data: [] };
    }
    return { data: [] };
  });
  useServerStore.setState({ current: { id: "server-coalesce-1" } as never, serverEpoch: 1 });

  const state = useChannelStore.getState();
  await Promise.all([state.loadChannels(), state.loadChannels(), state.loadChannels()]);
  assert.equal(channelFetches, 1, "concurrent loadChannels calls must share one in-flight request");

  // Coalescing covers the in-flight window only; a later genuine refresh fetches again.
  await state.loadChannels();
  assert.equal(channelFetches, 2, "coalescing is per in-flight, not a cache");
});

test("loadServers coalesces boot-time fan-in onto one request", async () => {
  const api = (await import("../src/api/client")).default;
  const { useServerStore } = await import("../src/store/serverStore");
  let serverFetches = 0;
  vi.spyOn(api, "get").mockImplementation(async (url: string) => {
    if (url === "/servers") {
      serverFetches += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      return { data: [] };
    }
    return { data: [] };
  });
  useServerStore.setState({
    loadMembers: async () => undefined,
    loadSidebarOrder: async () => undefined,
  } as never);

  const state = useServerStore.getState();
  await Promise.all([state.loadServers(), state.loadServers(), state.loadServers()]);
  assert.equal(serverFetches, 1, "concurrent loadServers calls must share one in-flight request");
});

test("loadMachines coalesces concurrent triggers onto one request", async () => {
  const api = (await import("../src/api/client")).default;
  const { useMachineStore } = await import("../src/store/machineStore");
  const { useServerStore } = await import("../src/store/serverStore");
  let machineFetches = 0;
  vi.spyOn(api, "get").mockImplementation(async (url: string) => {
    if (url === "/servers/server-coalesce-3/machines") {
      machineFetches += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      return { data: [] };
    }
    return { data: [] };
  });
  useServerStore.setState({ current: { id: "server-coalesce-3" } as never, serverEpoch: 1 });

  const state = useMachineStore.getState();
  await Promise.all([state.loadMachines(), state.loadMachines()]);
  assert.equal(machineFetches, 1, "concurrent loadMachines calls must share one in-flight request");
});

test("channel members-updated refreshes only the affected channel row, never the whole list", async () => {
  const { buildMainLayoutSocketBindings, installSocketBridge } = await import("../src/store/socketBridge");
  const { useChannelStore } = await import("../src/store/channelStore");
  const { socket, fire } = makeMainLayoutSocket();
  let listLoads = 0;
  const ensured: Array<{ id: string; refresh?: boolean }> = [];
  vi.spyOn(useChannelStore.getState(), "loadChannels").mockImplementation(async () => {
    listLoads += 1;
  });
  vi.spyOn(useChannelStore.getState(), "ensureChannel").mockImplementation(async (channelId: string, opts?: { refresh?: boolean }) => {
    ensured.push({ id: channelId, refresh: opts?.refresh });
    return null;
  });

  const bindings = buildMainLayoutSocketBindings(
    socket,
    () => undefined,
    async () => undefined,
    () => undefined,
    () => undefined,
  );
  const uninstall = installSocketBridge(socket, "channel-realtime-members-targeted", bindings);
  try {
    fire("channel:members-updated", { channelId: "chan-targeted-9" });
    await waitFor(() => assert.equal(ensured.length, 1));
    assert.equal(ensured[0]!.id, "chan-targeted-9");
    assert.equal(ensured[0]!.refresh, true);
    assert.equal(listLoads, 0, "a members event for a known channel must not refetch the whole list");

    // Payloads without a channel id keep the whole-list fallback.
    fire("channel:members-updated", {});
    await waitFor(() => assert.equal(listLoads, 1));
  } finally {
    uninstall();
  }
});
