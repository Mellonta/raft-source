// Grant parity between the legacy agent routes and the Agent API.
//
// Protected property: every legacy `/internal/agent/:id/*` route gated by
// `requireAgentScope(scope)` has an `/internal/agent-api/*` counterpart whose
// handler chain requires the same grant. The expected pairs are derived from
// `internalRouter` itself (the way `middleware/agentRouteScopeCoverage.test.ts`
// walks it), so adding a grant-gated legacy route without gating its Agent API
// twin, or registering an Agent API operation without its entry in
// `AGENT_API_ROUTE_GRANTS`, fails here instead of silently skipping grants.

import assert from "node:assert/strict";

import { getStaticAgentScope } from "../middleware/agentScope";
import { internalRouter } from "./internal";
import { internalAgentApiRouter } from "./internalAgentApi";

interface GatedRoute {
  /** `<METHOD> <path>` with `/agent/:id` stripped and params normalized to `:_`. */
  key: string;
  literal: string;
  scope: string | null;
}

/**
 * Legacy routes whose Agent API twin lives at a different path. Keyed by the
 * normalized legacy route, valued by the normalized Agent API route.
 */
const RENAMED_COUNTERPARTS: Readonly<Record<string, string>> = {
  // `raft message check` drains /events; the CLI client rewrites /receive to it.
  "GET /receive": "GET /events",
};

function normalize(method: string, path: string, stripPrefix: string): string {
  const stripped = path.startsWith(stripPrefix) ? path.slice(stripPrefix.length) || "/" : path;
  return `${method.toUpperCase()} ${stripped.replace(/:[A-Za-z0-9_]+/g, ":_")}`;
}

function walk(router: unknown, stripPrefix: string, filter: (path: string) => boolean): GatedRoute[] {
  const out: GatedRoute[] = [];
  const stack = (router as { stack: Array<Record<string, unknown>> }).stack;
  for (const layer of stack) {
    const route = layer.route as
      | { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> }
      | undefined;
    if (!route || typeof route.path !== "string" || !filter(route.path)) continue;
    let scope: string | null = null;
    for (const inner of route.stack) {
      scope = getStaticAgentScope(inner.handle);
      if (scope) break;
    }
    for (const [method, enabled] of Object.entries(route.methods)) {
      if (!enabled) continue;
      out.push({ key: normalize(method, route.path, stripPrefix), literal: `${method.toUpperCase()} ${route.path}`, scope });
    }
  }
  return out;
}

test("every grant-gated legacy agent route has an Agent API counterpart requiring the same grant", () => {
  const legacy = walk(internalRouter, "/agent/:id", (p) => p.startsWith("/agent/:id")).filter((r) => r.scope);
  assert.ok(legacy.length > 0, "expected grant-gated legacy routes");

  const agentApi = new Map<string, GatedRoute>();
  for (const r of walk(internalAgentApiRouter, "", () => true)) {
    // First registration wins, matching Express dispatch order.
    if (!agentApi.has(r.key)) agentApi.set(r.key, r);
  }

  const problems: string[] = [];
  for (const l of legacy) {
    const targetKey = RENAMED_COUNTERPARTS[l.key] ?? l.key;
    const twin = agentApi.get(targetKey);
    if (!twin) {
      problems.push(`${l.literal} (grant ${l.scope}) has no Agent API route at ${targetKey}; add the operation's grant or record the rename in RENAMED_COUNTERPARTS`);
      continue;
    }
    if (twin.scope !== l.scope) {
      problems.push(`${twin.literal} requires grant ${twin.scope ?? "none"} but its legacy counterpart ${l.literal} requires ${l.scope}; add it to AGENT_API_ROUTE_GRANTS or requireAgentGrant(...)`);
    }
  }
  assert.equal(problems.length, 0, `\n  ${problems.join("\n  ")}\n`);
});

test("renamed counterparts point at registered routes on both routers", () => {
  const legacyKeys = new Set(walk(internalRouter, "/agent/:id", (p) => p.startsWith("/agent/:id")).map((r) => r.key));
  const agentApiKeys = new Set(walk(internalAgentApiRouter, "", () => true).map((r) => r.key));
  for (const [from, to] of Object.entries(RENAMED_COUNTERPARTS)) {
    assert.ok(legacyKeys.has(from), `${from}: no such legacy route; remove the stale rename`);
    assert.ok(agentApiKeys.has(to), `${to}: no such Agent API route; remove the stale rename`);
  }
});
