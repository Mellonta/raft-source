/**
 * task #359 — RFC 072 §7 passive AX ("peripheral vision") rollout gate.
 *
 * The server decides per server through the `passive_ax` feature flag
 * (`AgentConfig.passiveAx`). Locally, `RAFT_PASSIVE_AX=0` is a kill switch,
 * read from both the agent's `agents.env_vars` and the daemon process env:
 * either one saying off turns it off (it is an emergency stop, not a tuning
 * knob, so unlike wake recycle the agent's value cannot override the
 * machine's), and no env value can turn the gate on without the server flag.
 * The composed value is published to the CLI through the context-generation
 * record, never through the runtime's environment, so an agent cannot flip it
 * per command.
 */
export const PASSIVE_AX_ENV = "RAFT_PASSIVE_AX";

function parseBooleanFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "on") return true;
  if (normalized === "0" || normalized === "false" || normalized === "off" || normalized === "") return false;
  return undefined;
}

export function resolvePassiveAx(
  serverEnabled: boolean | null | undefined,
  agentEnvVars: Record<string, string> | null | undefined,
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  const agentOff = parseBooleanFlag(agentEnvVars?.[PASSIVE_AX_ENV]) === false;
  const machineOff = parseBooleanFlag(processEnv[PASSIVE_AX_ENV]) === false;
  return serverEnabled === true && !agentOff && !machineOff;
}
