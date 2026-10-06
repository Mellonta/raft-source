import assert from "node:assert/strict";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InvalidGrantError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import {
  isManagedMcpAddressAllowed,
  ManagedMcpGatewayError,
  normalizeManagedMcpClientError,
  normalizeManagedMcpClientErrorForConnection,
  normalizeManagedMcpToolCatalog,
  validateManagedMcpEndpoint,
} from "./managedMcpGateway";

test("managed MCP endpoint validation accepts public HTTPS endpoints", () => {
  assert.equal(validateManagedMcpEndpoint("https://docs.mcp.cloudflare.com/mcp").toString(), "https://docs.mcp.cloudflare.com/mcp");
  assert.equal(
    validateManagedMcpEndpoint("https://auth.example.com/authorize?response_type=code&state=opaque").searchParams.get("state"),
    "opaque",
    "OAuth authorization URLs keep standard query parameters",
  );
  assert.equal(isManagedMcpAddressAllowed("8.8.8.8"), true);
  assert.equal(isManagedMcpAddressAllowed("2606:4700:4700::1111"), true);
});

test("managed MCP endpoint validation rejects unsafe URL forms", () => {
  for (const url of [
    "http://example.com/mcp",
    "https://user:pass@example.com/mcp",
    "https://example.com/mcp#fragment",
    "https://localhost/mcp",
    "https://service.internal/mcp",
    "https://127.0.0.1/mcp",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/mcp",
  ]) {
    assert.throws(() => validateManagedMcpEndpoint(url), ManagedMcpGatewayError, url);
  }
});

test("managed MCP address policy blocks private, reserved, translated, and mapped addresses", () => {
  for (const address of [
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "172.16.0.1", "192.88.99.1", "192.168.1.1",
    "::1", "64:ff9b::1", "100::1", "2001:db8::1", "2002::1", "3fff::1", "5f00::1",
    "fc00::1", "fe80::1", "::ffff:127.0.0.1",
  ]) {
    assert.equal(isManagedMcpAddressAllowed(address), false, address);
  }
});

test("managed MCP client errors distinguish reconnect-required OAuth from transient provider failures", () => {
  for (const error of [
    new UnauthorizedError(),
    new InvalidGrantError("refresh token revoked"),
    new StreamableHTTPError(401, "token rejected after refresh"),
  ]) {
    // These SDK OAuth errors can only arise on OAuth connections.
    assert.equal(normalizeManagedMcpClientError(error, false, 'oauth').code, "managed_mcp_oauth_required");
  }
  assert.equal(normalizeManagedMcpClientError(new ServerError("temporarily unavailable"), false).code, "managed_mcp_unreachable");
  assert.equal(normalizeManagedMcpClientError(new Error("network reset"), false).code, "managed_mcp_unreachable");
  assert.equal(normalizeManagedMcpClientError(new Error("deadline"), true).message, "MCP request timed out");
});

test("managed MCP catalog normalization bounds schemas and keeps only typed annotations", () => {
  assert.deepEqual(normalizeManagedMcpToolCatalog([{
    name: "search",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    annotations: { readOnlyHint: true, unexpected: "discard" },
  }]), [{
    name: "search",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    annotations: { readOnlyHint: true },
  }]);
  assert.throws(() => normalizeManagedMcpToolCatalog([{
    name: " padded ",
    inputSchema: { type: "object" },
  }]), ManagedMcpGatewayError);
  assert.throws(() => normalizeManagedMcpToolCatalog([{
    name: "huge",
    inputSchema: { type: "object", examples: ["x".repeat(600 * 1024)] },
  }]), ManagedMcpGatewayError);
});

test("managed MCP 401/403 copy follows the connection auth mode (afe07b8d right-cause)", () => {
  const rejected = new StreamableHTTPError(401, "Unauthorized");
  // authMode=none/headers: endpoint rejection must never wear OAuth wording
  const none = normalizeManagedMcpClientError(rejected, false, 'none');
  assert.equal(none.code, "managed_mcp_endpoint_auth_rejected");
  assert.ok(!/oauth/i.test(none.message), `none-mode copy leaked OAuth wording: ${none.message}`);
  const forbidden = new StreamableHTTPError(403, "Forbidden");
  assert.equal(normalizeManagedMcpClientError(forbidden, false, 'none').code, "managed_mcp_endpoint_auth_rejected");
  // mirror tooth: a real OAuth connection keeps the reconnect contract
  const oauth = normalizeManagedMcpClientError(rejected, false, 'oauth');
  assert.equal(oauth.code, "managed_mcp_oauth_required");
  assert.match(oauth.message, /OAuth authorization expired/);
  // OAuth SDK-level unauthorized is still reconnect for OAuth connections only
  assert.equal(normalizeManagedMcpClientError(new UnauthorizedError(), false, 'oauth').code, "managed_mcp_oauth_required");
  // non-auth statuses stay unreachable regardless of mode
  assert.equal(normalizeManagedMcpClientError(new StreamableHTTPError(500, "boom"), false, 'none').code, "managed_mcp_unreachable");
});

test("managed MCP headers-mode 401 copy names configured credentials (Tao A)", () => {
  const copy = normalizeManagedMcpClientError(new StreamableHTTPError(401, "Unauthorized"), false, "headers");
  assert.equal(copy.code, "managed_mcp_endpoint_auth_rejected");
  assert.match(copy.message, /configured credentials/);
  assert.ok(!/oauth/i.test(copy.message));
  assert.ok(!/without credentials/.test(copy.message));
});

test("managed MCP OAuth transport path keeps reconnect copy when provider rejects with 401", () => {
  const copy = normalizeManagedMcpClientErrorForConnection(
    new StreamableHTTPError(401, "Unauthorized"),
    false,
    {},
    {} as never,
  );
  assert.equal(copy.code, "managed_mcp_oauth_required");
  assert.match(copy.message, /OAuth authorization expired/);
});
