import { buildCliSystemPrompt, SUBAGENT_DELEGATION_SECTION, type SystemPromptOptions } from "./systemPrompt";
import { ClaudeDriver } from "./claude";
import { promptConfig } from "../testing/promptFixture";

const options: SystemPromptOptions = {
  extraCriticalRules: [],
};

test("display-name fallback preserves the independent mention handle", () => {
  for (const displayName of ["Display Sentinel", ""]) {
    const prompt = buildCliSystemPrompt(promptConfig({ name: "handle-sentinel", displayName }), options);
    expect(prompt).toContain(`You are "${displayName || "handle-sentinel"}"`);
    expect(prompt).toContain("`@handle-sentinel`");
    expect(prompt).not.toContain("`@Display Sentinel`");
  }
});

test("role and runtime context are optional and do not bleed between agents", () => {
  const populated = buildCliSystemPrompt(promptConfig({
    description: "role-sentinel",
    runtimeContext: {
      agentId: "agent-sentinel", serverId: "server-sentinel", machineId: "computer-sentinel",
      machineName: "name-sentinel", machineHostname: "host-sentinel", machineOs: "os-sentinel",
      daemonVersion: "version-sentinel", workspacePath: "/workspace-sentinel",
    },
  }), options);
  for (const value of ["role-sentinel", "agent-sentinel", "server-sentinel", "computer-sentinel",
    "name-sentinel", "host-sentinel", "os-sentinel", "version-sentinel", "/workspace-sentinel"]) {
    expect(populated).toContain(value);
  }

  const empty = buildCliSystemPrompt(promptConfig(), options);
  expect(empty).not.toContain("sentinel");
  expect(empty).not.toContain("## Current Runtime Context");
  expect(empty).not.toContain("## Initial role");

  const roleOnly = buildCliSystemPrompt(promptConfig({ description: "role-sentinel" }), options);
  expect(roleOnly).toContain("role-sentinel");
  expect(roleOnly).not.toContain("## Current Runtime Context");
  const contextOnly = buildCliSystemPrompt(promptConfig({
    runtimeContext: { agentId: "agent-1", serverId: "server-1", machineId: "computer-1" },
  }), options);
  expect(contextOnly).toContain("computer-1");
  expect(contextOnly).not.toContain("- Role:");
});

test.each([
  { machineName: "computer-name", machineId: "computer-id", label: "computer-name (computer-id)" },
  { machineName: "computer-name", machineId: null, label: "computer-name" },
  { machineName: null, machineId: "computer-id", label: "computer-id" },
])("computer label falls back with $machineName / $machineId", ({ machineName, machineId, label }) => {
  const prompt = buildCliSystemPrompt(promptConfig({
    runtimeContext: { agentId: "agent-1", serverId: "server-1", machineId, machineName },
  }), options);
  expect(prompt.split("\n").filter((line) => line.startsWith("- Computer:"))).toEqual([`- Computer: ${label}`]);
});

test("release notices are rendered; retired migration controls never enter standing instructions", () => {
  const release = buildCliSystemPrompt(promptConfig({
    runtimeProfileControl: { kind: "daemon_release_notice", key: "release-1", message: "release-sentinel" },
  }), options);
  expect(release.split("release-sentinel")).toHaveLength(2);
  const migration = buildCliSystemPrompt(promptConfig({
    runtimeProfileControl: { kind: "migration", key: "migration-1", message: "migration-sentinel" },
  }), options);
  expect(migration).toBe(buildCliSystemPrompt(promptConfig(), options));
});

test("the MEMORY.md size target appears only for agents with constructed wake context on", () => {
  const target = /MEMORY\.md\*\* is always the index\. Keep it concise but comprehensive as a table of contents\. Target \*\*16 KB or less\*\*/;
  assert.match(buildCliSystemPrompt(promptConfig({ constructedWakeContext: true }), options), target);
  assert.notMatch(buildCliSystemPrompt(promptConfig({}), options), /KB or less/);
  assert.notMatch(buildCliSystemPrompt(promptConfig({ constructedWakeContext: false }), options), /KB or less/);
});

// Task #319: the Server sends an installed-app snapshot with `agent:start`.
test("the sub-agent section needs both the server flag and runtime support; otherwise the prompt is unchanged", () => {
  const baseline = buildCliSystemPrompt(promptConfig(), options);
  const capable: SystemPromptOptions = { ...options, supportsSubagents: true };
  for (const [config, opts] of [
    [promptConfig(), capable],
    [promptConfig({ subagentDelegation: false }), capable],
    [promptConfig({ subagentDelegation: true }), options],
    [promptConfig({ subagentDelegation: true }), { ...options, supportsSubagents: false }],
  ] as const) {
    expect(buildCliSystemPrompt(config, opts)).toBe(baseline);
  }

  const on = buildCliSystemPrompt(promptConfig({ subagentDelegation: true }), capable);
  expect(on).toContain(`\n\n${SUBAGENT_DELEGATION_SECTION}\n\n## @Mentions`);
  expect(on.replace(`${SUBAGENT_DELEGATION_SECTION}\n\n`, "")).toBe(baseline);
  expect(on.indexOf("### Splitting tasks for parallel execution")).toBeLessThan(on.indexOf("## Working through sub-agents"));
});

test("[wiring] the Claude driver declares sub-agent support", () => {
  const config = promptConfig({ subagentDelegation: true });
  expect(String(new ClaudeDriver().buildSystemPrompt(config, "agent-1"))).toContain("## Working through sub-agents");
});

test("[wiring] a delivered installed-app snapshot reaches the prompt", () => {
  const prompt = buildCliSystemPrompt(promptConfig({
    installedApps: [
      { name: "Sentinel App", description: "does sentinel things", whenToUse: "when sentinel work is needed" },
    ],
  }), options);
  expect(prompt).toContain("Installed on this Server");
  expect(prompt).toContain("Sentinel App");
  expect(prompt).toContain("when sentinel work is needed");
});

test("[wiring-empty] no snapshot and an empty snapshot both degrade to the historical prompt", () => {
  const absent = buildCliSystemPrompt(promptConfig({}), options);
  const empty = buildCliSystemPrompt(promptConfig({ installedApps: [] }), options);
  expect(absent).not.toContain("Installed on this Server");
  expect(empty).toBe(absent);
});

test("[wiring-inert] an app with an empty whenToUse is omitted, not rendered blank", () => {
  const prompt = buildCliSystemPrompt(promptConfig({
    installedApps: [
      { name: "No Hint App", description: null, whenToUse: "" },
      { name: "Hinted App", description: null, whenToUse: "when hinted" },
    ],
  }), options);
  expect(prompt).not.toContain("No Hint App");
  expect(prompt).toContain("Hinted App");
});
