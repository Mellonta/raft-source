import { PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { type DatabaseExecutor, getDb } from "../db/index";
import { evaluateFeatureFlag } from "./featureFlagService";

export async function isProviderConnectionsEnabled(
  serverId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  const evaluation = await evaluateFeatureFlag({
    key: PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
    serverId,
  }, executor);
  return evaluation.enabled;
}

export async function isProviderProbesEnabled(
  serverId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  const evaluation = await evaluateFeatureFlag({
    key: PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
    serverId,
  }, executor);
  return evaluation.enabled;
}

export async function isProviderProbeEnforcementEnabled(
  serverId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  const evaluation = await evaluateFeatureFlag({
    key: PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
    serverId,
  }, executor);
  return evaluation.enabled;
}
