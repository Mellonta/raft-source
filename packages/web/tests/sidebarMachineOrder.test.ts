import assert from "node:assert/strict";
import { orderSidebarMachineIds } from "../src/components/layout/sidebarMachineOrder";

// Task #124 follow-up: the sidebar's Computers list puts the host-pinned
// machine ("this device" on desktop) first, then the user's own computers,
// then the rest — each group in the server's stable order.

const m = (id: string, mine = false) => ({ id, computerAttachedByCurrentUser: mine });

test("no pin: my computers first, then others, both stable", () => {
  assert.deepEqual(
    orderSidebarMachineIds([m("a"), m("b", true), m("c"), m("d", true)], null),
    ["b", "d", "a", "c"],
  );
});

test("the pinned machine leads even when it is not mine; the rest keeps its groups", () => {
  assert.deepEqual(
    orderSidebarMachineIds([m("a"), m("b", true), m("c"), m("d", true)], "c"),
    ["c", "b", "d", "a"],
  );
  assert.deepEqual(
    orderSidebarMachineIds([m("a"), m("b", true), m("c"), m("d", true)], "d"),
    ["d", "b", "a", "c"],
  );
});

test("a pin that matches no machine changes nothing; empty input stays empty", () => {
  assert.deepEqual(orderSidebarMachineIds([m("a"), m("b", true)], "zzz"), ["b", "a"]);
  assert.deepEqual(orderSidebarMachineIds([], "a"), []);
});
