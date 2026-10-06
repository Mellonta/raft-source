// task #359: the passive AX gate is server flag AND local kill switch; the
// kill switch can only turn it off, and either place (agent env_vars or the
// daemon process env) saying off is enough.
import assert from "node:assert/strict";
import { test } from "vitest";

import { PASSIVE_AX_ENV, resolvePassiveAx } from "./passiveAxGate";

const noEnv: NodeJS.ProcessEnv = {};

test("off without the server flag, whatever the env says", () => {
  assert.equal(resolvePassiveAx(undefined, null, noEnv), false);
  assert.equal(resolvePassiveAx(false, null, noEnv), false);
  assert.equal(resolvePassiveAx(undefined, { [PASSIVE_AX_ENV]: "1" }, { [PASSIVE_AX_ENV]: "1" }), false);
});

test("on with the server flag and no local opinion", () => {
  assert.equal(resolvePassiveAx(true, null, noEnv), true);
  assert.equal(resolvePassiveAx(true, {}, {}), true);
});

test("the daemon process env can kill it", () => {
  for (const off of ["0", "false", "off", ""]) {
    assert.equal(resolvePassiveAx(true, null, { [PASSIVE_AX_ENV]: off }), false, JSON.stringify(off));
  }
  assert.equal(resolvePassiveAx(true, null, { [PASSIVE_AX_ENV]: "1" }), true);
});

test("either place saying off wins: an agent's env_vars cannot override the machine's kill switch, nor vice versa", () => {
  assert.equal(resolvePassiveAx(true, { [PASSIVE_AX_ENV]: "1" }, { [PASSIVE_AX_ENV]: "0" }), false);
  assert.equal(resolvePassiveAx(true, { [PASSIVE_AX_ENV]: "0" }, { [PASSIVE_AX_ENV]: "1" }), false);
  assert.equal(resolvePassiveAx(true, { [PASSIVE_AX_ENV]: "1" }, { [PASSIVE_AX_ENV]: "1" }), true);
});

test("an unparseable value is no opinion", () => {
  assert.equal(resolvePassiveAx(true, { [PASSIVE_AX_ENV]: "maybe" }, noEnv), true);
  assert.equal(resolvePassiveAx(true, null, { [PASSIVE_AX_ENV]: "yes please" }), true);
});
