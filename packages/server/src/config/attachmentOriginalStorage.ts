import type { ServerId } from "@botiverse/raft-shared";
import type { DatabaseExecutor } from "../db/index";
import {
  ATTACHMENT_ORIGINAL_STORAGE_V2_FEATURE_FLAG_KEY,
  evaluateFeatureFlag,
} from "../services/featureFlagService";

/**
 * Controls only which namespace is selected for a newly-created attachment.
 * Reads, deletes, replay, and presigned URLs always route from the persisted key.
 */
export async function isAttachmentOriginalStorageV2EnabledForServer(
  serverId: string,
  executor?: DatabaseExecutor,
): Promise<boolean> {
  const evaluation = await evaluateFeatureFlag({
    key: ATTACHMENT_ORIGINAL_STORAGE_V2_FEATURE_FLAG_KEY,
    serverId: serverId as ServerId,
  }, executor);
  return evaluation.enabled;
}
