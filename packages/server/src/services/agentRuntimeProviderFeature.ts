import { ANTIPROTON_HOSTED_RUNTIME_FEATURE_FLAG_KEY, type AgentRuntimeProviderKind } from "@botiverse/raft-shared";
import { type DatabaseExecutor, getDb } from "../db/index";
import { evaluateFeatureFlag } from "./featureFlagService";
import { isProviderDeploymentConfigured } from "./agentRuntimeProviderService";

const FLAG_BY_PROVIDER: Record<AgentRuntimeProviderKind, string> = {
  antiproton: ANTIPROTON_HOSTED_RUNTIME_FEATURE_FLAG_KEY,
};

/** Server-scoped gate (default off; enabled per server through the flag's rules). */
export async function isAgentRuntimeProviderEnabledForServer(
  serverId: string,
  kind: AgentRuntimeProviderKind,
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  const evaluation = await evaluateFeatureFlag({ key: FLAG_BY_PROVIDER[kind], serverId }, executor);
  return evaluation.enabled;
}

export type AgentRuntimeProviderAvailability =
  | { available: true }
  | { available: false; reason: "flag_disabled" | "not_configured" };

/** Both gates: the deployment is configured AND the server has the flag. */
export async function getAgentRuntimeProviderAvailability(
  serverId: string,
  kind: AgentRuntimeProviderKind,
): Promise<AgentRuntimeProviderAvailability> {
  if (!await isAgentRuntimeProviderEnabledForServer(serverId, kind)) return { available: false, reason: "flag_disabled" };
  if (!isProviderDeploymentConfigured(kind)) return { available: false, reason: "not_configured" };
  return { available: true };
}
