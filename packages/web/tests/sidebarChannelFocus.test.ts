import assert from "node:assert/strict";
import {
  buildSidebarChannelFocusState,
  buildSidebarDisclosureRestoreState,
  centeredSidebarScrollTop,
  isSidebarDisclosureRestoreState,
  readSidebarChannelFocusRequest,
  conversationFromPathname,
  implicitSidebarFocusRequest,
  nearestSidebarScrollTop,
} from "../src/components/layout/sidebarChannelFocus";

test("sidebar channel focus navigation state is exact and fail closed", () => {
  const state = buildSidebarChannelFocusState("channel-42");
  assert.deepEqual(readSidebarChannelFocusRequest(state), {
    kind: "channel",
    id: "channel-42",
    align: "center",
  });
  assert.equal(readSidebarChannelFocusRequest(null), null);
  assert.equal(readSidebarChannelFocusRequest({ sidebarChannelFocus: {} }), null);
  // Task #125 widened the request: DM conversations and the "nearest"
  // alignment are valid; anything else still fails closed.
  assert.deepEqual(readSidebarChannelFocusRequest({
    sidebarChannelFocus: {
      kind: "dm",
      id: "channel-42",
      align: "center",
    },
  }), { kind: "dm", id: "channel-42", align: "center" });
  assert.deepEqual(readSidebarChannelFocusRequest({
    sidebarChannelFocus: {
      kind: "channel",
      id: "channel-42",
      align: "nearest",
    },
  }), { kind: "channel", id: "channel-42", align: "nearest" });
  assert.equal(readSidebarChannelFocusRequest({
    sidebarChannelFocus: {
      kind: "channel",
      id: "channel-42",
      align: "top",
    },
  }), null);
});

test("default-route disclosure restore state is exact and fail closed", () => {
  assert.equal(isSidebarDisclosureRestoreState(buildSidebarDisclosureRestoreState()), true);
  assert.equal(isSidebarDisclosureRestoreState(null), false);
  assert.equal(isSidebarDisclosureRestoreState({ sidebarDisclosureRestore: false }), false);
  assert.equal(isSidebarDisclosureRestoreState({ sidebarDisclosureRestore: "true" }), false);
});

test("sidebar centering targets the requested row without scrolling above zero", () => {
  assert.equal(centeredSidebarScrollTop({
    currentScrollTop: 100,
    itemHeight: 40,
    itemTop: 250,
    viewportHeight: 400,
    viewportTop: 50,
  }), 120);
  assert.equal(centeredSidebarScrollTop({
    currentScrollTop: 0,
    itemHeight: 32,
    itemTop: 40,
    viewportHeight: 500,
    viewportTop: 20,
  }), 0);
});

// Task #125: a route change to a different conversation implies a "nearest"
// reveal; the first render, the same conversation, and non-conversation routes
// imply nothing.
test("implicit sidebar focus follows conversation changes in the route and nothing else", () => {
  assert.equal(implicitSidebarFocusRequest(null, "/s/server/channel/c1"), null, "first render is not a navigation");
  assert.deepEqual(implicitSidebarFocusRequest("/s/server", "/s/server/channel/c1"), { kind: "channel", id: "c1", align: "nearest" });
  assert.deepEqual(implicitSidebarFocusRequest("/s/server/channel/c1", "/s/server/dm/d1"), { kind: "dm", id: "d1", align: "nearest" });
  assert.equal(implicitSidebarFocusRequest("/s/server/channel/c1", "/s/server/channel/c1/thread/m9"), null, "moving inside the same conversation");
  assert.equal(implicitSidebarFocusRequest("/s/server/channel/c1", "/s/server/search?q=x"), null, "leaving conversations");
  assert.deepEqual(conversationFromPathname("/s/server/dm/d%201"), { kind: "dm", id: "d 1" });
  assert.equal(conversationFromPathname("/s/server/computers"), null);
});

test("nearest scroll moves the least and not at all when the row is already visible", () => {
  const viewport = { currentScrollTop: 50, viewportHeight: 200, viewportTop: 20, itemHeight: 40 };
  assert.equal(nearestSidebarScrollTop({ ...viewport, itemTop: 100 }), null, "fully visible → no scroll");
  assert.equal(nearestSidebarScrollTop({ ...viewport, itemTop: 300 }), 50 + 300 - 20 - (200 - 40), "below → align bottom");
  assert.equal(nearestSidebarScrollTop({ ...viewport, itemTop: -10 }), 50 + -10 - 20, "above → align top");
  assert.equal(nearestSidebarScrollTop({ ...viewport, currentScrollTop: 0, itemTop: -10 }), 0, "never above zero");
});

test("focus state round-trips DM kind and the nearest alignment, still fail closed otherwise", () => {
  assert.deepEqual(readSidebarChannelFocusRequest(buildSidebarChannelFocusState("d1", "dm")), { kind: "dm", id: "d1", align: "center" });
  assert.deepEqual(readSidebarChannelFocusRequest({ sidebarChannelFocus: { kind: "channel", id: "c1", align: "nearest" } }), { kind: "channel", id: "c1", align: "nearest" });
  assert.equal(readSidebarChannelFocusRequest({ sidebarChannelFocus: { kind: "agent", id: "a1", align: "center" } }), null);
  assert.equal(readSidebarChannelFocusRequest({ sidebarChannelFocus: { kind: "channel", id: "c1", align: "top" } }), null);
});
