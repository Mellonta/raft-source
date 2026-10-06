import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import type { ServerId } from "@botiverse/raft-shared";
import { openTestApp } from "../test/integration/app";
import {
  ATTACHMENT_DIRECT_UPLOAD_FEATURE_FLAG_KEY,
  createFeatureFlag,
  createFeatureFlagRule,
} from "../services/featureFlagService";
import { isAttachmentDirectUploadEnabledForServer } from "./attachmentDirectUpload";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

test("direct attachment upload resolver is server-scoped and defaults closed", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  const allowedServerId = "00000000-0000-4000-8000-00000000da01" as ServerId;
  const deniedServerId = "00000000-0000-4000-8000-00000000da02" as ServerId;
  try {
    await createFeatureFlag({
      key: ATTACHMENT_DIRECT_UPLOAD_FEATURE_FLAG_KEY,
      randomizationUnit: "server",
      defaultEnabled: false,
    });
    await createFeatureFlagRule({
      flagKey: ATTACHMENT_DIRECT_UPLOAD_FEATURE_FLAG_KEY,
      stage: "server",
      decision: "allow",
      values: [allowedServerId],
    });

    assert.equal(await isAttachmentDirectUploadEnabledForServer({ serverId: allowedServerId }), true);
    assert.equal(await isAttachmentDirectUploadEnabledForServer({
      serverId: allowedServerId,
      userId: "00000000-0000-4000-8000-00000000da03",
    }), true);
    assert.equal(await isAttachmentDirectUploadEnabledForServer({ serverId: deniedServerId }), false);
  } finally {
    await close();
  }
});
