import { describe, expect, it } from "vitest";
import {
  buildIntegrationInviteUrl,
  INTEGRATION_INVITE_ROUTE,
  integrationInvitePath,
} from "./integrationInvitePaths";

describe("integration invite paths", () => {
  it("builds the canonical plural path with an encoded token", () => {
    expect(integrationInvitePath("raft_share_abc")).toBe("/integration-invites/raft_share_abc");
    expect(integrationInvitePath("a/b c")).toBe("/integration-invites/a%2Fb%20c");
  });

  it("joins the app url without doubling slashes", () => {
    expect(buildIntegrationInviteUrl("https://raft.example", "tok")).toBe("https://raft.example/integration-invites/tok");
    expect(buildIntegrationInviteUrl("https://raft.example/", "tok")).toBe("https://raft.example/integration-invites/tok");
  });

  it("builds paths that match the web route pattern", () => {
    expect(INTEGRATION_INVITE_ROUTE).toBe("/integration-invites/:token");
    const routePrefix = INTEGRATION_INVITE_ROUTE.replace(/:token$/, "");
    expect(integrationInvitePath("tok").startsWith(routePrefix)).toBe(true);
  });
});
