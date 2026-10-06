import assert from "node:assert/strict";

import {
  projectSlackProviderChannelsForServer,
  slackActorProjectionRevisionAfterRefresh,
} from "./slackBridgeProvisioningControlPlane";

const currentActor = {
  displayName: "Peng",
  handles: ["peng"],
  actorKind: "human" as const,
  state: "active" as const,
  deactivated: false,
  projectionRevision: 76,
};

test("freshness-only Slack audience refresh preserves the actor authority revision", () => {
  assert.equal(slackActorProjectionRevisionAfterRefresh(currentActor, {
    id: "U_PENG",
    displayName: "Peng",
    handle: "peng",
    actorKind: "human",
  }), 76);
});

test("material Slack actor changes advance the actor authority revision exactly once", () => {
  const changes = [
    { displayName: "Peng Renamed", handle: "peng", actorKind: "human" as const },
    { displayName: "Peng", handle: "peng-new", actorKind: "human" as const },
    { displayName: "Peng", handle: "peng", actorKind: "guest" as const },
  ];
  for (const observed of changes) {
    assert.equal(slackActorProjectionRevisionAfterRefresh(currentActor, {
      id: "U_PENG",
      ...observed,
    }), 77);
  }
  assert.equal(slackActorProjectionRevisionAfterRefresh({
    ...currentActor,
    state: "tombstoned",
    deactivated: true,
  }, {
    id: "U_PENG",
    displayName: "Peng",
    handle: "peng",
    actorKind: "human",
  }), 77);
});

test("another server's reserved Slack channel is omitted without exposing its binding", () => {
  const projected = projectSlackProviderChannelsForServer({
    observed: [
      { id: "C_OWN", name: "own", privacyClass: "public" },
      { id: "C_OTHER", name: "secret-other-server-name", privacyClass: "private" },
      { id: "C_FREE", name: "free", privacyClass: "public" },
    ],
    currentBindings: [{ providerConversationId: "C_OWN", privacyClass: "public" }],
    reservedByOtherServer: new Set(["C_OTHER"]),
  });
  assert.deepEqual(projected.map((channel) => channel.id), ["C_OWN", "C_FREE"]);
  assert.equal(JSON.stringify(projected).includes("secret-other-server-name"), false);
});
