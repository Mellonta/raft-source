/**
 * Vitest setup for the daemon package: unit tests do not reach the network.
 *
 * A request that arrives at a real transport with no test mock in the way is
 * recorded and rejected, and the test that was running fails naming the method
 * and URL. Loopback hosts and `.invalid` names stay open: the first for tests
 * that start their own local server, the second because they cannot resolve to
 * any host. Covered transports: `daemonFetch` (through its test baseline, which
 * per-test mock/restore cycles return to) and `globalThis.fetch`. Raw
 * `http`/`net` clients are not covered. A file whose subject is the transport
 * itself opens named hosts with `permitRealNetworkInThisFile(reason, hosts)`.
 *
 * Registered in `vitest.config.ts` (`setupFiles`). Fire-and-forget senders
 * such as runner-credential revoke swallow the rejection, so the failure is
 * raised from `afterEach`/`afterAll`, not from the call site.
 */
import { afterAll, afterEach } from "vitest";
import { fetch as undiciFetch } from "undici";
import { setDaemonFetchBaselineForTests } from "../daemonFetch";

export type RecordedNetworkAttempt = { transport: "daemonFetch" | "fetch"; method: string; url: string };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);
const attempts: RecordedNetworkAttempt[] = [];

/** Test-only: take (and clear) the attempts recorded so far. */
export function takeRecordedNetworkAttempts(): RecordedNetworkAttempt[] {
  return attempts.splice(0);
}

function requestUrl(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input === "object" && typeof (input as { url?: unknown }).url === "string") {
    return (input as { url: string }).url;
  }
  return String(input);
}

function requestMethod(input: unknown, init: { method?: string } | undefined): string {
  const fromRequest = input && typeof input === "object" ? (input as { method?: unknown }).method : undefined;
  const method = init?.method ?? (typeof fromRequest === "string" ? fromRequest : "GET");
  return method.toUpperCase();
}

// Loopback, and `.invalid` names (RFC 2606): those cannot resolve to any host
// (the resolver answers NXDOMAIN), so a test may aim at them to exercise its
// own failure path.
function cannotLeaveTheMachine(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".invalid");
  } catch {
    return false;
  }
}

const permittedHosts = new Set<string>();

/**
 * Test-only: let requests to exactly these hosts (URL hostname, no port) reach
 * the real transport in this test file. For files whose subject is the
 * transport itself and that aim at unroutable addresses on purpose, such as a
 * black-hole proxy. Every other host stays guarded. State is per test file:
 * the setup module is instantiated once per file.
 */
export function permitRealNetworkInThisFile(reason: string, hosts: readonly string[]): void {
  if (!reason.trim() || hosts.length === 0) throw new Error("permitRealNetworkInThisFile needs a reason and at least one host");
  for (const host of hosts) permittedHosts.add(host);
}

function isPermittedHost(url: string): boolean {
  if (permittedHosts.size === 0) return false;
  try {
    return permittedHosts.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

type AnyFetch = (input: unknown, init?: { method?: string }) => Promise<unknown>;

function guarded<T>(transport: RecordedNetworkAttempt["transport"], real: T): T {
  const call = real as unknown as AnyFetch;
  return ((input: unknown, init?: { method?: string }) => {
    const url = requestUrl(input);
    if (cannotLeaveTheMachine(url) || isPermittedHost(url)) return call(input, init);
    const method = requestMethod(input, init);
    attempts.push({ transport, method, url });
    return Promise.reject(new Error(
      `daemon unit tests do not reach the network: ${transport} ${method} ${url} (inject fetchImpl or install a daemonFetch mock)`,
    ));
  }) as unknown as T;
}

setDaemonFetchBaselineForTests(guarded("daemonFetch", undiciFetch));
globalThis.fetch = guarded("fetch", globalThis.fetch.bind(globalThis)) as typeof fetch;

function failOnRecordedAttempts(when: string): void {
  const seen = takeRecordedNetworkAttempts();
  if (seen.length === 0) return;
  const list = seen.map((attempt) => `${attempt.transport} ${attempt.method} ${attempt.url}`).join("\n  ");
  throw new Error(`${seen.length} request(s) tried to leave the daemon unit test process ${when}:\n  ${list}`);
}

afterEach(() => failOnRecordedAttempts("during this test"));
afterAll(() => failOnRecordedAttempts("after the last test in this file"));
