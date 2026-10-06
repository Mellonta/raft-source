// The routes layer: one typed method per Agent API route, derived from the
// shared contract by construction (`client.<resource>.<method>` bindings in
// `agentApiContract`), plus the per-route operating metadata every projection
// shares. This is the SDK's code-level escape hatch and the guarantee that the
// SDK reaches every route the CLI does; higher-level operations build on it.

import {
  createAgentApiClient,
  type AgentApiClient,
  type AgentApiClientResult,
  type AgentApiFetchTransportOptions,
} from "@botiverse/raft-shared/src/agentApiClient";
import {
  agentApiContract,
  type AgentApiCapability,
  type AgentApiRequestBodyByRoute,
  type AgentApiRequestParamsByRoute,
  type AgentApiRequestQueryByRoute,
  type AgentApiRouteKey,
} from "@botiverse/raft-shared/src/agentApiContract";
import type {
  AgentApiRawClientResource,
  AgentApiRawClientResourceMethod,
  AgentApiRouteKeyForClient,
} from "@botiverse/raft-shared/src/agentApiRawClient";
import {
  AGENT_API_ROUTE_META,
  getAgentApiRetryPolicy,
  toAgentApiToolAnnotations,
  type AgentApiRetryPolicy,
  type AgentApiRouteMeta,
  type AgentApiToolAnnotations,
} from "@botiverse/raft-shared/src/agentApiRouteMeta";
import { AGENT_API_MANIFEST_VERSION, AGENT_API_ROUTE_MANIFEST } from "@botiverse/raft-shared/src/generated/agentApiRoutes";

export type RaftRouteKey = AgentApiRouteKey;
export type RaftRouteResult<K extends RaftRouteKey> = AgentApiClientResult<K>;
export type RaftRouteMeta = AgentApiRouteMeta;
export type RaftRouteRetryPolicy = AgentApiRetryPolicy;
export type RaftRouteAnnotations = AgentApiToolAnnotations;

/** Everything the SDK knows about one route without calling it. */
export interface RaftRouteInfo extends RaftRouteMeta {
  key: RaftRouteKey;
  method: string;
  path: string;
  fullPath: string;
  client: { resource: string; method: string };
  capability: AgentApiCapability;
  description: string;
  retryPolicy: RaftRouteRetryPolicy;
  annotations: RaftRouteAnnotations;
}

/**
 * `routes.<resource>.<method>({ params, query, body })` (one named object, typed per route) for every route in the
 * contract, plus route introspection. Reads retry (bounded); writes and
 * destructive reads make exactly one attempt regardless of client retry
 * settings, because the contract says repeating them is not safe.
 */
type RoutePart<Name extends string, T> = [T] extends [never]
  ? { [P in Name]?: never }
  : {} extends T
    ? { [P in Name]?: T }
    : { [P in Name]: T };

/**
 * The single input every route takes: `{ params, query, body }`, typed per
 * route. A part the route does not have is `never` (passing it is a compile
 * error); a part with required fields is a required property.
 */
export type RaftRouteInput<K extends RaftRouteKey> =
  & RoutePart<"params", AgentApiRequestParamsByRoute[K]>
  & RoutePart<"query", AgentApiRequestQueryByRoute[K]>
  & RoutePart<"body", AgentApiRequestBodyByRoute[K]>;

export type RaftRouteMethod<K extends RaftRouteKey> = {} extends RaftRouteInput<K>
  ? (input?: RaftRouteInput<K>) => Promise<RaftRouteResult<K>>
  : (input: RaftRouteInput<K>) => Promise<RaftRouteResult<K>>;

/** `routes.<resource>.<method>({ params, query, body })` for every route in the contract. */
export type RaftRouteMethods = {
  [R in AgentApiRawClientResource]: {
    [M in AgentApiRawClientResourceMethod<R>]: RaftRouteMethod<AgentApiRouteKeyForClient<R, M>>;
  };
};

/** The positional client the SDK's operations use internally. Not part of the public API. */
export type RaftRouteClient = AgentApiClient;

export type RaftRoutes = RaftRouteMethods & {
  /** The same call by route key: `request("actionPrepare", { body })`. */
  request<K extends RaftRouteKey>(routeKey: K, input?: RaftRouteInput<K>): Promise<RaftRouteResult<K>>;
  /** Content hash of the route manifest this SDK was built against. */
  manifestVersion: string;
  /** Static description of one route: capability, side effect, idempotency, audience, retry policy. */
  describe(key: RaftRouteKey): RaftRouteInfo;
  /** All routes, in contract order. */
  list(): RaftRouteInfo[];
};

const ROUTE_INFO: Record<RaftRouteKey, RaftRouteInfo> = Object.fromEntries(
  AGENT_API_ROUTE_MANIFEST.map((entry) => {
    const meta = AGENT_API_ROUTE_META[entry.key];
    return [entry.key, {
      key: entry.key,
      method: entry.method,
      path: entry.path,
      fullPath: entry.fullPath,
      client: entry.client,
      capability: entry.capability,
      description: entry.description,
      ...meta,
      retryPolicy: getAgentApiRetryPolicy(meta),
      annotations: toAgentApiToolAnnotations(meta),
    }];
  }),
) as Record<RaftRouteKey, RaftRouteInfo>;

export function describeRaftRoute(key: RaftRouteKey): RaftRouteInfo {
  return ROUTE_INFO[key];
}

export function listRaftRoutes(): RaftRouteInfo[] {
  return AGENT_API_ROUTE_MANIFEST.map((entry) => ROUTE_INFO[entry.key]);
}

export interface CreateRaftRoutesOptions {
  serverUrl: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  authorization: string;
  /** Bounded attempts for routes whose contract allows retry. Defaults to 1; capped at 5. */
  readAttempts?: number;
  beforeRequest?: AgentApiFetchTransportOptions["throttle"] extends { beforeRequest?: infer F } | undefined ? F : never;
}

function clampAttempts(value: number | undefined): number {
  return Math.min(Math.max(1, Math.trunc(value ?? 1)), 5);
}

/**
 * Build the routes layer over two transports: a retrying one for routes the
 * contract marks retry-safe, and a single-attempt one for everything else.
 * The split is decided per route from `AGENT_API_ROUTE_META`, never by the
 * caller and never by the HTTP method.
 */
export function createRaftRouteClient(options: CreateRaftRoutesOptions): RaftRouteClient {
  const base = {
    baseUrl: options.serverUrl,
    fetch: options.fetch,
    headers: options.headers,
    auth: { authorization: options.authorization },
    throttle: { beforeRequest: options.beforeRequest },
  } satisfies AgentApiFetchTransportOptions;
  const retrying = createAgentApiClient({ fetch: { ...base, retry: { attempts: clampAttempts(options.readAttempts) } } });
  const single = createAgentApiClient({ fetch: { ...base, retry: { attempts: 1 } } });

  const merged: Record<string, Record<string, unknown>> = {};
  for (const route of Object.values(agentApiContract)) {
    const key = route.key as RaftRouteKey;
    const policy = ROUTE_INFO[key].retryPolicy;
    // `retry_when_keyed` cannot be decided statically (it depends on the body
    // carrying an idempotency key), so the routes layer stays single-attempt
    // for it; the operations layer decides per call.
    const client = policy === "retry" ? retrying : single;
    const resource = (client as unknown as Record<string, Record<string, unknown>>)[route.client.resource];
    merged[route.client.resource] ??= {};
    merged[route.client.resource][route.client.method] = resource[route.client.method];
  }

  return {
    ...(merged as unknown as AgentApiClient),
    request: (routeKey, requestOptions) => {
      const client = ROUTE_INFO[routeKey].retryPolicy === "retry" ? retrying : single;
      return client.request(routeKey, requestOptions);
    },
  };
}

const ROUTE_PARTS = ["params", "query", "body"] as const;

function inputMismatch<K extends RaftRouteKey>(routeKey: K, message: string): Promise<RaftRouteResult<K>> {
  return Promise.resolve({
    ok: false,
    routeKey,
    error: { kind: "validation", reason: "request_contract_mismatch", message: `Agent API ${routeKey} ${message}` },
  } as RaftRouteResult<K>);
}

/**
 * The public routes layer: one named-object call shape for every route,
 * `routes.<resource>.<method>({ params, query, body })`. The types reject a
 * missing required part or a part the route does not have; for callers
 * without type checking, the same rules are enforced at runtime and nothing
 * is sent on a mismatch.
 */
export function raftRoutesFromClient(client: RaftRouteClient): RaftRoutes {
  const call = <K extends RaftRouteKey>(routeKey: K, args: readonly unknown[]): Promise<RaftRouteResult<K>> => {
    if (args.length > 1) return inputMismatch(routeKey, `takes one { params, query, body } object; got ${args.length} arguments`);
    const input = args[0];
    if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input))) {
      return inputMismatch(routeKey, "takes one { params, query, body } object");
    }
    const route = agentApiContract[routeKey];
    const declared = ROUTE_PARTS.filter((part) => part in route.request);
    const given = input === undefined ? [] : Object.keys(input as object);
    const unknown = given.filter((key) => !(declared as readonly string[]).includes(key));
    if (unknown.length > 0) {
      return inputMismatch(routeKey, `has no ${unknown.join(", ")} (it takes ${declared.join(", ") || "no input"})`);
    }
    return client.request(routeKey, (input ?? {}) as never) as Promise<RaftRouteResult<K>>;
  };
  const methods: Record<string, Record<string, unknown>> = {};
  for (const route of Object.values(agentApiContract)) {
    const key = route.key as RaftRouteKey;
    methods[route.client.resource] ??= {};
    methods[route.client.resource][route.client.method] = (...args: unknown[]) => call(key, args);
  }
  return {
    ...(methods as unknown as RaftRouteMethods),
    request: (routeKey, ...rest: unknown[]) => call(routeKey, rest),
    manifestVersion: AGENT_API_MANIFEST_VERSION,
    describe: describeRaftRoute,
    list: listRaftRoutes,
  } as RaftRoutes;
}

/** Build the public routes layer directly (convenience over createRaftRouteClient + raftRoutesFromClient). */
export function createRaftRoutes(options: CreateRaftRoutesOptions): RaftRoutes {
  return raftRoutesFromClient(createRaftRouteClient(options));
}
