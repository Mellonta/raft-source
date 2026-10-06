import assert from "node:assert/strict";
import axios from "axios";
import api from "../src/api/client";
import { updateAuthRuntimeSnapshot } from "../src/utils/authSessionRuntime";
import {
  __resetAuthTraceForTest,
  setAuthTraceFetchForTest,
  setAuthTraceServerIdGetter,
} from "../src/utils/webAuthTrace";

/**
 * task #632 — a 401 for someone who never signed in must not end a session that
 * never existed.
 *
 * Found via task #115 / PR #8112: a visitor hovering an agent on a PUBLIC page
 * triggered a protected request, the 401 reached the interceptor, no refresh
 * token was found, and that was read as a hard session failure — so their
 * storage was cleared and they were redirected off the page they were reading.
 * #8112 removed one trigger (the hover card); this removes the behaviour, which
 * any future protected request on a public page would otherwise reproduce.
 *
 * This drives the REAL axios instance through its REAL response interceptor,
 * not the policy function. `protectedRequestAuthPolicy.test.ts` already pins the
 * decision; the failure this file exists for is the WIRING going dead — drop
 * `hasAccessToken` from the call in `api/client.ts` and the policy tests all stay
 * green while the visitor gets redirected again.
 */

type StubStore = Record<string, string>;

function stubLocalStorage(initial: StubStore): { restore: () => void } {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const store: StubStore = { ...initial };
  const stub: Storage = {
    get length() {
      return Object.keys(store).length;
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    getItem: (k: string) => (k in store ? store[k]! : null),
    key: (i: number) => Object.keys(store)[i] ?? null,
    removeItem: (k: string) => {
      delete store[k];
    },
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: stub });
  return {
    restore: () => {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else Reflect.deleteProperty(globalThis, "localStorage");
    },
  };
}

function stubWindowLocation(initialHref = "https://app.example.test/public-server"): {
  restore: () => void;
  href: () => string;
} {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const win = { location: { href: initialHref } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: win });
  return {
    href: () => win.location.href,
    restore: () => {
      if (original) Object.defineProperty(globalThis, "window", original);
      else Reflect.deleteProperty(globalThis, "window");
    },
  };
}

/** Every request answers 401, like a protected endpoint seen by a stranger. */
function stubUnauthorizedAdapter(): { restore: () => void } {
  const original = api.defaults.adapter;
  api.defaults.adapter = async (config) => {
    throw new axios.AxiosError(
      "Request failed with status code 401",
      "ERR_BAD_REQUEST",
      config,
      null,
      {
        status: 401,
        statusText: "Unauthorized",
        data: {},
        headers: {},
        config,
      } as never,
    );
  };
  return {
    restore: () => {
      api.defaults.adapter = original;
    },
  };
}

function silenceAuthTrace() {
  __resetAuthTraceForTest();
  setAuthTraceServerIdGetter(() => undefined);
  setAuthTraceFetchForTest(async () => new Response("{}", { status: 200 }));
}

async function get401(): Promise<unknown> {
  try {
    await api.get("/agents/agent-1");
    return null;
  } catch (error) {
    return error;
  }
}

test("a 401 for a caller holding NO tokens rejects and leaves the page alone", async () => {
  const storage = stubLocalStorage({});
  const win = stubWindowLocation();
  const adapter = stubUnauthorizedAdapter();
  silenceAuthTrace();
  try {
    const error = await get401();

    assert.ok(error, "the request must reject so the caller can handle its own 401");
    // The two halves of "logged out": storage cleared and page navigated.
    assert.equal(
      win.href(),
      "https://app.example.test/public-server",
      "a visitor must not be redirected off the page they were reading",
    );
    assert.equal(localStorage.getItem("slock_access_token"), null);
    assert.equal(localStorage.getItem("slock_refresh_token"), null);
  } finally {
    adapter.restore();
    win.restore();
    storage.restore();
    __resetAuthTraceForTest();
  }
});

test("POSITIVE CONTROL: a tab whose sibling logged out still ends its session", async () => {
  // @Josh's review of this PR: tab A logs out and clears storage, so tab B has
  // the visitor's exact token inputs. What it still has is its restore state,
  // and that is what keeps it on the session-ended path — otherwise it would sit
  // on a page that looks signed in while every request 401s.
  const storage = stubLocalStorage({});
  const win = stubWindowLocation();
  const adapter = stubUnauthorizedAdapter();
  silenceAuthTrace();
  const snapshotBefore = { initialized: false, restoreState: "booting" as const };
  updateAuthRuntimeSnapshot({ initialized: true, restoreState: "authenticated" });
  try {
    await get401();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(win.href(), "/", "a tab that had a session must still be redirected");
  } finally {
    updateAuthRuntimeSnapshot(snapshotBefore);
    adapter.restore();
    win.restore();
    storage.restore();
    __resetAuthTraceForTest();
  }
});

test("POSITIVE CONTROL: a 401 for a caller holding an access token still ends the session", async () => {
  // Without this the change could be "never log anyone out", which is a worse
  // bug wearing the same diff. An expired session holds at least one token.
  const storage = stubLocalStorage({ slock_access_token: "expired-access-token" });
  const win = stubWindowLocation();
  const adapter = stubUnauthorizedAdapter();
  silenceAuthTrace();
  try {
    await get401();
    // clearAuthAndRedirect awaits a terminal trace flush before navigating.
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(win.href(), "/", "a dead session must still be cleared and redirected");
    assert.equal(localStorage.getItem("slock_access_token"), null);
  } finally {
    adapter.restore();
    win.restore();
    storage.restore();
    __resetAuthTraceForTest();
  }
});
