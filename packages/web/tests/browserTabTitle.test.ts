import assert from "node:assert/strict";
import {
  genericAppDocumentTitle,
  getServerRouteDocumentTitle,
  hostShellFallbackDocumentTitle,
  serverRouteChannelId,
  serverRouteDmId,
  serverRouteAgentId,
  serverRouteMachineId,
} from "../src/utils/browserDocumentTitle";

const server = { name: "Botiverse", slug: "botiverse" };
const fallbacks = {
  agent: "Agent",
  computer: "Computer",
  computers: "Computers",
};

test("server routes keep the server label first by default", () => {
  assert.equal(getServerRouteDocumentTitle("/s/botiverse", server), "Botiverse | Raft");
  assert.equal(
    getServerRouteDocumentTitle("/s/botiverse/agent/agent-1", server, { agentLabel: "Jony" }),
    "Botiverse | Raft",
  );
  assert.equal(genericAppDocumentTitle(), "Raft");
});

test("browser titles prefer the active channel label on channel and DM routes", () => {
  assert.equal(
    getServerRouteDocumentTitle("/s/botiverse/channel/channel-1", server, { channelLabel: "#wg-drafts-build" }),
    "#wg-drafts-build | Botiverse | Raft",
  );
  assert.equal(
    getServerRouteDocumentTitle("/s/other/channel/channel-1", { name: "Other server", slug: "other" }, { channelLabel: "#wg-drafts-build" }),
    "#wg-drafts-build | Other server | Raft",
  );
  assert.equal(serverRouteChannelId("/s/botiverse/channel/channel-1", server.slug), "channel-1");

  assert.equal(
    getServerRouteDocumentTitle("/s/botiverse/dm/dm-1", server, { channelLabel: "@Cindy" }),
    "@Cindy | Botiverse | Raft",
  );
  assert.equal(serverRouteDmId("/s/botiverse/dm/dm-1", server.slug), "dm-1");
});

test("browser thread titles retain the parent channel context", () => {
  assert.equal(
    getServerRouteDocumentTitle(
      "/s/botiverse/channel/channel-1",
      server,
      { channelLabel: "#wg-drafts-build", threadChannelLabel: "#wg-drafts-build" },
    ),
    "#wg-drafts-build - Thread | Botiverse | Raft",
  );

  assert.equal(
    getServerRouteDocumentTitle(
      "/s/botiverse/dm/dm-1",
      server,
      { channelLabel: "@Cindy", threadChannelLabel: "@Cindy" },
    ),
    "@Cindy - Thread | Botiverse | Raft",
  );
});

test("host-shell Computers routes publish only the native header title", () => {
  assert.equal(hostShellFallbackDocumentTitle(fallbacks), "Computers");
  assert.equal(
    getServerRouteDocumentTitle("/s/botiverse/computers", server, {}, true, fallbacks),
    "Computers",
  );
  assert.equal(
    getServerRouteDocumentTitle(
      "/s/botiverse/channel/channel-1",
      server,
      { channelLabel: "#wg-drafts-build", threadChannelLabel: "#wg-drafts-build" },
      true,
      fallbacks,
    ),
    "Computers",
  );
  assert.equal(
    getServerRouteDocumentTitle("/s/botiverse/computer/machine-1", server, { machineLabel: "Jony's Mac" }, true, fallbacks),
    "Jony's Mac",
  );
  assert.equal(serverRouteMachineId("/s/botiverse/machine/machine-2", server.slug), "machine-2");
});

test("host-shell Computer-to-Agent navigation publishes the loaded Agent display name", () => {
  assert.equal(
    getServerRouteDocumentTitle("/s/botiverse/agent/agent-1", server, { agentLabel: "Jony" }, true, fallbacks),
    "Jony",
  );
  assert.equal(serverRouteAgentId("/s/botiverse/agent/agent-1", server.slug), "agent-1");
});

test("host-shell detail titles fail soft before their entity store has loaded", () => {
  assert.equal(
    getServerRouteDocumentTitle("/s/botiverse/agent/agent-1", server, {}, true, fallbacks),
    "Agent",
  );
  assert.equal(
    getServerRouteDocumentTitle("/s/botiverse/computer/machine-1", server, { machineLabel: "A | B" }, true, fallbacks),
    "A | B",
  );
});
