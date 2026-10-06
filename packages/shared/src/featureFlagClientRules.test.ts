import assert from "node:assert/strict";
import {
  clientRuleConstraintsSatisfied,
  clientRuleShapeError,
  findClientRuleBypassConflicts,
  parseFeatureFlagClientFacts,
} from "./featureFlagClientRules";

const X = "10000000-0000-4000-8000-000000000001";
const Y = "10000000-0000-4000-8000-000000000002";
const clientRule = { stage: "client", values: [X], percentageBasisPoints: null, variant: null };

test("shape: client fields are only valid on the client stage", () => {
  assert.equal(clientRuleShapeError({ ...clientRule, stage: "server" }), null);
  assert.match(clientRuleShapeError({ ...clientRule, stage: "server", clientOs: ["android"] }) ?? "", /only valid on client-stage/);
  assert.match(clientRuleShapeError({ ...clientRule, stage: "percentage", clientBuildTypes: ["alpha"] }) ?? "", /only valid/);
});

test("shape: a client rule needs a target server, a constraint, and valid values", () => {
  assert.equal(clientRuleShapeError({ ...clientRule, clientOs: ["android"], minClientBuild: 11_200_132, clientBuildTypes: ["release"] }), null);
  assert.match(clientRuleShapeError({ ...clientRule }) ?? "", /at least one of/);
  assert.match(clientRuleShapeError({ ...clientRule, values: [], clientOs: ["ios"] }) ?? "", /target server/);
  assert.match(clientRuleShapeError({ ...clientRule, values: [X, X], clientOs: ["ios"] }) ?? "", /target server/);
  assert.match(clientRuleShapeError({ ...clientRule, clientOs: ["ios"], variant: "v" }) ?? "", /variants/);
  assert.match(clientRuleShapeError({ ...clientRule, clientOs: ["ios"], percentageBasisPoints: 10 }) ?? "", /percentage/);
  assert.match(clientRuleShapeError({ ...clientRule, clientOs: ["web"] }) ?? "", /clientOs/);
  assert.match(clientRuleShapeError({ ...clientRule, clientOs: [] }) ?? "", /clientOs/);
  assert.match(clientRuleShapeError({ ...clientRule, clientOs: ["ios", "ios"] }) ?? "", /clientOs/);
  assert.match(clientRuleShapeError({ ...clientRule, clientBuildTypes: ["connectedTest"] }) ?? "", /clientBuildTypes/);
  assert.match(clientRuleShapeError({ ...clientRule, minClientBuild: -1 }) ?? "", /minClientBuild/);
  assert.match(clientRuleShapeError({ ...clientRule, minClientBuild: 1.5 }) ?? "", /minClientBuild/);
});

test("constraints: every set constraint must be reported and pass (AND, fail closed)", () => {
  const rule = { clientOs: ["android"], minClientBuild: 11_200_132, clientBuildTypes: ["release"] };
  assert.equal(clientRuleConstraintsSatisfied(rule, { os: "android", buildNumber: 11_200_132, buildType: "release" }), true);
  assert.equal(clientRuleConstraintsSatisfied(rule, { os: "android", buildNumber: 11_200_131, buildType: "release" }), false);
  assert.equal(clientRuleConstraintsSatisfied(rule, { os: "ios", buildNumber: 11_200_132, buildType: "release" }), false);
  assert.equal(clientRuleConstraintsSatisfied(rule, { os: "android", buildNumber: 11_200_132, buildType: "alpha" }), false);
  assert.equal(clientRuleConstraintsSatisfied(rule, { os: "android", buildNumber: 11_200_132 }), false);
  assert.equal(clientRuleConstraintsSatisfied(rule, null), false);
  // A rule with no constraint never matches (the CHECK forbids it anyway).
  assert.equal(clientRuleConstraintsSatisfied({}, { os: "android", buildNumber: 1, buildType: "release" }), false);
  // Android alpha: type only, no build floor (alpha numbering is separate).
  assert.equal(clientRuleConstraintsSatisfied({ clientOs: ["android"], clientBuildTypes: ["alpha"] }, { os: "android", buildNumber: 1_000_031, buildType: "alpha" }), true);
});

test("parse: unknown or malformed facts become null and never throw", () => {
  assert.deepEqual(parseFeatureFlagClientFacts({ os: "android", buildNumber: "1120131", buildType: "alpha" }), { os: "android", buildNumber: 1_120_131, buildType: "alpha" });
  assert.deepEqual(parseFeatureFlagClientFacts({ os: "ohos", buildNumber: 42 }), { os: "ohos", buildNumber: 42, buildType: null });
  assert.deepEqual(parseFeatureFlagClientFacts({}), { os: null, buildNumber: null, buildType: null });
  for (const body of [
    { os: "desktop", buildNumber: "1.12.0", buildType: "ALPHA" },
    { os: 7, buildNumber: -5, buildType: "connectedTest" },
    { os: null, buildNumber: 1.5, buildType: null },
    { buildNumber: "12345678901234567890" },
  ]) {
    assert.deepEqual(parseFeatureFlagClientFacts(body), { os: null, buildNumber: null, buildType: null }, JSON.stringify(body));
  }
});

test("bypass: every later stage that can grant the flag conflicts with a client allow", () => {
  const client = { id: "c1", stage: "client", decision: "allow", values: [X] };
  const cases: Array<[Record<string, unknown>, string | null]> = [
    [{ id: "s1", stage: "server", decision: "allow", values: [X] }, "server_allow"],
    [{ id: "s2", stage: "server", decision: "allow", values: [Y] }, null], // other server
    [{ id: "s3", stage: "server", decision: "deny", values: [X] }, null],
    [{ id: "a1", stage: "audience", decision: "allow", values: ["beta"] }, "audience_allow"],
    [{ id: "a2", stage: "audience", decision: "deny", values: ["beta"] }, null],
    [{ id: "l1", stage: "lab", decision: "allow", values: ["composer"] }, "lab_allow"],
    [{ id: "pl1", stage: "plan", decision: "allow", values: ["pro"] }, "plan_allow"],
    [{ id: "pc1", stage: "percentage", decision: "allow", values: [], percentageBasisPoints: 1 }, "percentage_allow"],
    [{ id: "pc0", stage: "percentage", decision: "allow", values: [], percentageBasisPoints: 0 }, null],
    [{ id: "u1", stage: "user", decision: "allow", values: ["u"] }, null], // runs before client
    [{ id: "p1", stage: "platform", decision: "allow", values: ["mobile"] }, null], // runs before client
  ];
  for (const [later, kind] of cases) {
    const conflicts = findClientRuleBypassConflicts({ rules: [client, later as never] });
    assert.deepEqual(conflicts.map((conflict) => conflict.kind), kind ? [kind] : [], JSON.stringify(later));
  }
  assert.deepEqual(findClientRuleBypassConflicts({ rules: [client], defaultEnabled: true }), [
    { kind: "default_enabled", clientRuleId: "c1", bypassRuleId: null },
  ]);
  // No client allow: nothing can be bypassed.
  assert.deepEqual(findClientRuleBypassConflicts({
    rules: [{ ...client, decision: "deny" }, { id: "a1", stage: "audience", decision: "allow", values: ["beta"] }],
    defaultEnabled: true,
  }), []);
});

test("conflicts: a client allow and a server allow for the same server", () => {
  const rules = [
    { id: "c1", stage: "client", decision: "allow", values: [X, Y] },
    { id: "s1", stage: "server", decision: "allow", values: [Y] },
    { id: "s2", stage: "server", decision: "deny", values: [X] },
    { id: "c2", stage: "client", decision: "deny", values: [Y] },
    { id: "p1", stage: "platform", decision: "allow", values: ["mobile"] },
  ];
  assert.deepEqual(findClientRuleBypassConflicts({ rules }), [
    { kind: "server_allow", clientRuleId: "c1", bypassRuleId: "s1", serverId: Y },
  ]);
  assert.deepEqual(findClientRuleBypassConflicts({ rules: rules.filter((rule) => rule.id !== "s1") }), []);
});
