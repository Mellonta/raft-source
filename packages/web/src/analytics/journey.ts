// First RFC-067 journey events (reviewed with Vivian / meichen). Called from
// the click that opens a flow, not from the flow's own effects. Outcomes (an
// agent exists) stay database facts.

import type { ProductEventProperties } from "@botiverse/raft-shared";
import { trackEvent } from "./track";

export type AgentCreateEntry = NonNullable<ProductEventProperties<"agent_create_opened">["entry"]>;

/**
 * The user opened the create-agent dialog. Not called from the onboarding
 * wizard or action cards: those keep their own product_events funnels.
 */
export function trackAgentCreateOpened(entry: AgentCreateEntry): void {
  trackEvent("agent_create_opened", { entry });
}
