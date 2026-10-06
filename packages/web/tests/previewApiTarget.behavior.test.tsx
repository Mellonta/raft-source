import assert from "node:assert/strict";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import "./helpers/domSetup";
import { usePreviewApiTarget } from "../src/hooks/usePreviewApiTarget";
import { getPreviewEnvironmentDetails } from "../src/utils/devMode";

const originalFetch = globalThis.fetch;
const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
  else Reflect.deleteProperty(document, "visibilityState");
});

test("preview label follows both gateway target switches when returning to the page", async () => {
  let apiTarget = "prod";
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "/__raft_preview");
    assert.equal(init?.cache, "no-store");
    return Response.json({ apiTarget });
  };
  const { result } = renderHook(() => getPreviewEnvironmentDetails({ apiTarget: usePreviewApiTarget(true) }));
  await waitFor(() => assert.equal(result.current, "PROD DATA"));
  apiTarget = "staging";
  act(() => window.dispatchEvent(new window.Event("focus")));
  await waitFor(() => assert.equal(result.current, "STAGING DATA"));
  apiTarget = "prod";
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  act(() => document.dispatchEvent(new window.Event("visibilitychange")));
  await waitFor(() => assert.equal(result.current, "PROD DATA"));
});

test("unavailable or invalid gateway metadata never falls back to a stale target", async () => {
  let response = Response.json({ apiTarget: "prod" });
  globalThis.fetch = async () => response;
  const { result } = renderHook(() => usePreviewApiTarget(true));
  await waitFor(() => assert.equal(result.current, "prod"));
  response = new Response("unavailable", { status: 503 });
  act(() => window.dispatchEvent(new window.Event("focus")));
  await waitFor(() => assert.equal(result.current, null));
  response = Response.json({ apiTarget: "arbitrary" });
  await act(async () => window.dispatchEvent(new window.Event("focus")));
  assert.equal(result.current, null);
});

test("a superseded read cannot overwrite the current target and non-preview pages do not fetch", async () => {
  let finishOld: ((response: Response) => void) | undefined;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Promise<Response>((resolve) => { finishOld = resolve; });
    return Response.json({ apiTarget: "prod" });
  };
  const disabled = renderHook(() => usePreviewApiTarget(false));
  assert.equal(calls, 0);
  disabled.unmount();
  const { result } = renderHook(() => usePreviewApiTarget(true));
  act(() => window.dispatchEvent(new window.Event("focus")));
  await waitFor(() => assert.equal(result.current, "prod"));
  await act(async () => finishOld?.(Response.json({ apiTarget: "staging" })));
  assert.equal(result.current, "prod");
});
