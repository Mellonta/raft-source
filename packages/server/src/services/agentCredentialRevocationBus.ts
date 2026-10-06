// In-process fan-out for "an agent's credentials may no longer be valid".
//
// Long-lived `sk_agent_*` connections (today: `/internal/agent-api/wake-hints/stream`)
// authenticate once at open. When a credential is revoked or its agent is
// deleted, the writer broadcasts the agentId via
// `broadcastAgentCredentialRevocation` (replicaRouter.ts), which notifies this
// bus locally and publishes to every other replica over Redis; each replica's
// router re-notifies its own bus. Listeners re-validate their credential
// against the database — the signal carries no authority of its own, so a
// duplicate, stale or lost signal never grants access (the per-heartbeat
// re-validation remains the correctness floor).
//
// Leaf module: no imports from routes/services so replicaRouter can depend on it.

import { EventEmitter } from "node:events";

const bus = new EventEmitter();
bus.setMaxListeners(0);

export function subscribeAgentCredentialRevocation(agentId: string, listener: () => void): () => void {
  bus.on(agentId, listener);
  return () => {
    bus.off(agentId, listener);
  };
}

export function notifyLocalAgentCredentialRevocation(agentId: string): void {
  for (const listener of bus.listeners(agentId) as Array<() => void>) {
    try {
      listener();
    } catch (err) {
      console.error("[AgentCredentialRevocation] listener failed:", err);
    }
  }
}
