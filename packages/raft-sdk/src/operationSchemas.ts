// Request schemas of the operations implemented in the SDK itself (the rest
// live next to their operations in shared agentOps).

import { z } from "zod";
import { requestSchema } from "@botiverse/raft-shared/src/agentOps/index";

/** `identity.whoami` takes no arguments. */
export const whoamiRequestSchema = z.object({});

/** `inbox.commit`: no cursor commits the pending batch; a cursor commits up to it. */
export const commitInboxRequestSchema = requestSchema<{ cursor?: number | null }>()(z.object({
  cursor: z.number().int().nonnegative().nullable().optional().describe("Commit up to this batch cursor; omit to commit the batch the last inbox pull returned."),
}));
