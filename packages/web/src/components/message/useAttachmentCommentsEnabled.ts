import {
  ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY,
  useServerFeatureFlag,
} from "../../store/serverFeatureFlags";

export function useAttachmentCommentsEnabled(prefetch = true): boolean {
  return useServerFeatureFlag(ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY, { prefetch }).enabled;
}
