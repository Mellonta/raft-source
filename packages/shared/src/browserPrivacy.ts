// Separate subpath: load the policy before importing application modules that
// create identifiers, register telemetry listeners or load remote styles.
import { isRaftVendorUrl } from "./vendorUrl";

let enabled = false;

export function browserPrivacyMode(): boolean { return enabled; }

export async function initializeBrowserPrivacy(apiBase: string, socketBase?: string): Promise<void> {
  enabled = true;
  const endpoint = new URL(apiBase.replace(/\/$/, "") + "/privacy-mode", location.href);
  const page = new URL(location.href);
  // A self-hosted page can be served with a stale upstream API URL baked in.
  // Such an API cannot speak for the operator of this portal.
  const localPolicy = /^https?:$/.test(page.protocol) && !isRaftVendorUrl(page) && isRaftVendorUrl(endpoint);
  const policy = localPolicy ? new URL("/api/privacy-mode", page) : endpoint;
  try {
    const res = await fetch(policy, {
      credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(3000),
    });
    // An offline portal can still start. Never guess that tracking is allowed.
    if (res.ok && (await res.json())?.enabled === false) enabled = false;
  } catch { /* Fall back to private mode, without blocking the app. */ }
  if (!enabled) return;

  // Only deployment-controlled HTTP(S) origins, not values returned by the
  // policy endpoint. Preserve split web/API deployments and their WebSockets.
  const socket = new URL(socketBase || location.href, location.href);
  const origins = [endpoint, socket]
    .filter(url => !isRaftVendorUrl(url) && ["https:", "http:", "ws:", "wss:"].includes(url.protocol));
  const connections = [...new Set(origins.flatMap(url => [url.origin, url.origin.replace(/^http/, "ws")]))];
  const api = origins.includes(endpoint) && /^https?:$/.test(endpoint.protocol) ? endpoint.origin : "";
  // The browser can otherwise pre-resolve links before the user follows them.
  const dnsPolicy = document.createElement("meta");
  dnsPolicy.httpEquiv = "x-dns-prefetch-control";
  dnsPolicy.content = "off";
  document.head.append(dnsPolicy);
  const meta = document.createElement("meta");
  meta.httpEquiv = "Content-Security-Policy";
  meta.content = [
    "default-src 'self'", "base-uri 'self'", "form-action 'self'",
    `connect-src 'self' ${connections.join(" ")}`, `img-src 'self' data: blob: ${api}`,
    `media-src 'self' data: blob: ${api}`, `frame-src 'self' blob: ${api}`,
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'", "worker-src 'self' blob:",
    "font-src 'self' data:", "style-src 'self' 'unsafe-inline'", "object-src 'none'",
  ].join("; ");
  document.head.append(meta);
  if (isRaftVendorUrl(endpoint) || isRaftVendorUrl(socket)) {
    throw new Error("Privacy mode requires the portal API and socket URLs to point to your Raft deployment.");
  }
}
