// Proxy support for CLI HTTP client.
// Ported from packages/daemon/src/proxy.ts — only the fetch dispatcher
// parts; WebSocket proxy is not needed in the CLI.

import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";

const fetchDispatcherCache = new Map<string, Dispatcher>();

export type FetchTransportCauseClass = "dns" | "connect" | "tls" | "timeout" | "proxy" | "unknown";

export interface FetchTransportDiagnostics {
  url: string;
  causeClass: FetchTransportCauseClass;
  causeCode?: string;
  proxyUsed: boolean;
}

type ProxyAwareRequestInit = RequestInit & { dispatcher?: Dispatcher; duplex?: "half" };

// Keep fetch and its dispatcher on the same undici version. Node 26's built-in
// fetch (undici 8) drops response headers when paired with an undici 7 ProxyAgent,
// leaving gzip compressed and hiding the service callback's Set-Cookie headers.
const packageFetch: typeof fetch = (input, init) => undiciFetch(
  input as Parameters<typeof undiciFetch>[0],
  init as Parameters<typeof undiciFetch>[1],
) as unknown as Promise<Response>;
let canonicalFetchImpl = packageFetch;

/** Test-only transport seam; does not replace the process-global fetch. */
export function setCanonicalFetchImplForTests(impl: typeof fetch): typeof fetch {
  const previous = canonicalFetchImpl;
  canonicalFetchImpl = impl;
  return previous;
}

// A native Request belongs to Node's fetch implementation, so undici cannot
// consume it directly. Apply overrides with the native constructor, then pass
// the URL and standard request fields across the implementation boundary.
function packageFetchArgs(input: string | URL | Request, init: ProxyAwareRequestInit): [string | URL, ProxyAwareRequestInit] {
  if (typeof input === "string" || input instanceof URL) return [input, init];
  const { dispatcher, ...requestInit } = init;
  const request = new Request(input, requestInit);
  return [request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
    redirect: request.redirect,
    credentials: request.credentials,
    cache: request.cache,
    mode: request.mode,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    integrity: request.integrity,
    keepalive: request.keepalive,
    ...(request.body ? { duplex: "half" as const } : {}),
    dispatcher,
  }];
}

export class CanonicalFetchTransportError extends Error {
  readonly diagnostics: FetchTransportDiagnostics;

  constructor(input: {
    url: string;
    cause: unknown;
    proxyUsed: boolean;
  }) {
    const diagnostics = classifyFetchTransportFailure(input);
    const causeSuffix = diagnostics.causeCode ? `/${diagnostics.causeCode}` : "";
    super(`fetch failed for ${diagnostics.url}: ${diagnostics.causeClass}${causeSuffix}`);
    this.name = "CanonicalFetchTransportError";
    this.cause = input.cause;
    this.diagnostics = diagnostics;
  }
}

function getDefaultPort(protocol: string): string {
  switch (protocol) {
    case "https:":
      return "443";
    case "http:":
      return "80";
    default:
      return "";
  }
}

function hostMatchesNoProxyEntry(hostname: string, ruleHost: string): boolean {
  if (!ruleHost) return false;
  const normalizedRule = ruleHost.replace(/^\*\./, ".").replace(/^\./, "").toLowerCase();
  const normalizedHost = hostname.toLowerCase();
  return normalizedHost === normalizedRule || normalizedHost.endsWith(`.${normalizedRule}`);
}

function getProxyUrlForTarget(targetUrl: string, env: NodeJS.ProcessEnv): string | undefined {
  const protocol = new URL(targetUrl).protocol;

  switch (protocol) {
    case "https:":
      return env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy;
    case "http:":
      return env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
    default:
      return env.ALL_PROXY || env.all_proxy;
  }
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string" || input instanceof URL) return input.toString();
  return input.url;
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<object>();
  let current = error;
  while (chain.length < 8) {
    chain.push(current);
    if (typeof current !== "object" || !current || seen.has(current) || !("cause" in current)) break;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function nestedErrorCode(error: unknown): string {
  for (const item of errorChain(error)) {
    if (typeof item !== "object" || !item || !("code" in item)) continue;
    const code = (item as { code?: unknown }).code;
    if (typeof code === "string") return code.toUpperCase().slice(0, 80);
  }
  return "";
}

function nestedErrorMessage(error: unknown): string {
  return errorChain(error)
    .map((item) => item instanceof Error ? `${item.name} ${item.message}` : String(item ?? ""))
    .join(" ")
    .slice(0, 2_048)
    .toLowerCase();
}

/** Any failed name lookup is DNS, whatever code the resolver chose (some return EBUSY or EAI_FAIL, not ENOTFOUND). */
function isNameLookupFailure(error: unknown): boolean {
  return errorChain(error).some((item) =>
    typeof item === "object" && item !== null && (item as { syscall?: unknown }).syscall === "getaddrinfo");
}

function classifyFetchTransportFailure(input: {
  url: string;
  cause: unknown;
  proxyUsed: boolean;
}): FetchTransportDiagnostics {
  const code = nestedErrorCode(input.cause);
  const message = nestedErrorMessage(input.cause);
  let causeClass: FetchTransportCauseClass = "unknown";

  if (
    code === "ETIMEDOUT"
    || code.includes("TIMEOUT")
    || /\b(?:abort|timed? out|timeout)\b/.test(message)
  ) {
    causeClass = "timeout";
  } else if (
    code.includes("TLS")
    || code.includes("CERT")
    || code === "DEPTH_ZERO_SELF_SIGNED_CERT"
    || code === "SELF_SIGNED_CERT_IN_CHAIN"
    || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
    || /\b(?:tls|certificate|ssl)\b/.test(message)
  ) {
    causeClass = "tls";
  } else if (
    code === "ENOTFOUND"
    || code === "EAI_AGAIN"
    || isNameLookupFailure(input.cause)
    || /\bdns\b/.test(message)
  ) {
    // Before the proxy check: a lookup message names the host, and a host such
    // as `proxy-only.invalid` must not read as a proxy failure.
    causeClass = "dns";
  } else if (code.includes("PROXY") || /\bproxy\b/.test(message)) {
    causeClass = "proxy";
  } else if (
    code === "ECONNREFUSED"
    || code === "ECONNRESET"
    || code === "EHOSTUNREACH"
    || code === "ENETUNREACH"
    || code === "EPIPE"
    || code.startsWith("UND_ERR_CONNECT")
    || /\b(?:connect|connection|socket)\b/.test(message)
  ) {
    causeClass = input.proxyUsed ? "proxy" : "connect";
  }

  return {
    url: credentialFreeDiagnosticUrl(input.url),
    causeClass,
    causeCode: code || undefined,
    proxyUsed: input.proxyUsed,
  };
}

export function credentialFreeDiagnosticUrl(value: string | URL): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.hash = "";
  // Query values can carry one-time handoff codes. Keep the actual endpoint
  // and query keys while withholding values from agent-visible diagnostics.
  for (const key of Array.from(url.searchParams.keys())) {
    url.searchParams.set(key, "[redacted]");
  }
  return url.toString();
}

export function shouldBypassProxy(targetUrl: string, env: NodeJS.ProcessEnv): boolean {
  const rawNoProxy = env.NO_PROXY || env.no_proxy;
  if (!rawNoProxy) return false;

  const url = new URL(targetUrl);
  const hostname = url.hostname.toLowerCase();
  const port = url.port || getDefaultPort(url.protocol);

  return rawNoProxy
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .some((entry) => {
      if (entry === "*") return true;
      const [ruleHost, rulePort] = entry.split(":", 2);
      if (rulePort && rulePort !== port) return false;
      return hostMatchesNoProxyEntry(hostname, ruleHost);
    });
}

export function buildFetchDispatcher(
  targetUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Dispatcher | undefined {
  const proxyUrl = getProxyUrlForTarget(targetUrl, env);
  if (!proxyUrl) return undefined;
  if (shouldBypassProxy(targetUrl, env)) return undefined;

  const cached = fetchDispatcherCache.get(proxyUrl);
  if (cached) return cached;

  const dispatcher = new ProxyAgent(proxyUrl);
  fetchDispatcherCache.set(proxyUrl, dispatcher);
  return dispatcher;
}

export async function fetchWithCanonicalProxy(
  input: string | URL | Request,
  init: RequestInit = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  const targetUrl = requestUrl(input);
  const proxyConfigured = Boolean(getProxyUrlForTarget(targetUrl, env)) && !shouldBypassProxy(targetUrl, env);
  let dispatcher: Dispatcher | undefined;
  try {
    dispatcher = buildFetchDispatcher(targetUrl, env);
  } catch (cause) {
    throw new CanonicalFetchTransportError({ url: targetUrl, cause, proxyUsed: proxyConfigured });
  }

  const proxyAwareInit: ProxyAwareRequestInit = { ...init };
  if (dispatcher) proxyAwareInit.dispatcher = dispatcher;
  try {
    const [url, packageInit] = packageFetchArgs(input, proxyAwareInit);
    return await canonicalFetchImpl(url, packageInit);
  } catch (cause) {
    throw new CanonicalFetchTransportError({ url: targetUrl, cause, proxyUsed: Boolean(dispatcher) });
  }
}
