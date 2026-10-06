import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExternalMessageAuthorProjection } from "@botiverse/raft-shared";
import { useProfileStore } from "../src/store/profileStore";

const detailSource = readFileSync(
  fileURLToPath(new URL("../src/components/profile/ExternalIdentityDetailPanel.tsx", import.meta.url)),
  "utf8",
);
const messageItemSource = readFileSync(
  fileURLToPath(new URL("../src/components/message/MessageItem.tsx", import.meta.url)),
  "utf8",
);
const profilePanelSource = readFileSync(
  fileURLToPath(new URL("../src/components/profile/ProfilePanel.tsx", import.meta.url)),
  "utf8",
);

function projection(workspaceName: string | null): ExternalMessageAuthorProjection {
  return {
    projectionId: "projection-1",
    provider: "slack",
    appRegistrationId: "app-1",
    installId: "install-1",
    workspaceId: "opaque-workspace-id",
    workspaceName,
    externalActorId: "actor-1",
    externalConversationId: "conversation-1",
    externalMessageId: "message-1",
    displayName: "Ada Lovelace",
    actorKind: "human",
    avatarUrl: null,
    avatarDigest: null,
    actorProjectionRevision: 3,
  };
}

afterEach(() => {
  useProfileStore.setState(useProfileStore.getInitialState(), true);
});

test("external detail preserves the Joint Channel header-then-From information order", () => {
  const headerIndex = detailSource.indexOf("<PanelHeader");
  const bodyIndex = detailSource.indexOf("<ProfilePanelBody");
  const sourceIndex = detailSource.indexOf('data-testid="external-identity-source"');
  const profileIndex = detailSource.indexOf('context="profile-tile"');

  assert.ok(headerIndex >= 0);
  assert.ok(bodyIndex > headerIndex);
  assert.ok(sourceIndex > bodyIndex);
  assert.ok(profileIndex > sourceIndex);
  assert.match(detailSource, /id: "member\.detail\.from"/);
  assert.match(detailSource, /profile\.workspaceName \? \(/);
  assert.doesNotMatch(detailSource, /profile\.workspaceId/);
});

test("external profile store retains the frozen author payload and clears it on other navigation", () => {
  const frozen = projection("Analytical Engines");
  useProfileStore.getState().openExternalProfile("message-1", frozen, {
    channelId: "channel-1",
    openSource: "channel",
  });

  assert.equal(useProfileStore.getState().profileType, "external");
  assert.equal(useProfileStore.getState().profileId, "message-1");
  assert.equal(useProfileStore.getState().externalProfile, frozen);
  assert.equal(useProfileStore.getState().externalProfileChannelId, "channel-1");
  assert.equal(useProfileStore.getState().openSource, "channel");

  useProfileStore.getState().openProfile("human", "human-1");
  assert.equal(useProfileStore.getState().profileType, "human");
  assert.equal(useProfileStore.getState().externalProfile, null);
});

test("message click forwards the exact frozen author fact into the standard profile panel", () => {
  assert.match(
    messageItemSource,
    /openExternalProfile\(message\.id, profile, \{\s*channelId: message\.channelId,\s*openSource: parentMessageId \? "thread" : "channel",\s*\}\)/,
  );
  assert.match(messageItemSource, /onNavigateExternal=\{readOnlyProjection \? ignoreReadOnlyProjectionNavigation : handleNavigateExternal\}/);
  assert.match(profilePanelSource, /profileType === "external" && profileId && externalProfile/);
  assert.match(profilePanelSource, /<ExternalIdentityDetailPanel\s+profile=\{externalProfile\}/);
});

test("closing an external profile removes both its target and frozen payload", () => {
  useProfileStore.getState().openExternalProfile("message-1", projection(null), {
    channelId: "channel-1",
  });
  useProfileStore.getState().closeProfile();

  assert.equal(useProfileStore.getState().profileType, null);
  assert.equal(useProfileStore.getState().profileId, null);
  assert.equal(useProfileStore.getState().externalProfile, null);
  assert.equal(useProfileStore.getState().externalProfileChannelId, null);
});
