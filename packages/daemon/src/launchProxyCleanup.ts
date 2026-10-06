import { unregisterAgentCredentialProxiesForAgent } from "./agentCredentialProxy";
import { unregisterManagedMcpRuntimeProxiesForAgent } from "./managedMcpRuntimeProxy";

export function cleanupLaunchProxies(agentId: string): void {
  unregisterAgentCredentialProxiesForAgent(agentId);
  unregisterManagedMcpRuntimeProxiesForAgent(agentId);
}
