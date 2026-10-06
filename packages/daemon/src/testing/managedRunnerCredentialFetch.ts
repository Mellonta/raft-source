import { installDaemonFetchMockForTests } from "../daemonFetch";

/**
 * Test-only: serve the managed runner credential endpoints over daemonFetch.
 * A runtime restart strips the credential and mints a new one, and a stop
 * revokes it; tests that drive either path install this so the requests are
 * answered here instead of leaving the process. Anything else fails the way an
 * unreachable server would. Returns the restore function.
 *
 * `mint: "outstanding"` leaves every mint request pending, as a slow server
 * would, for tests that assert the state a restart is in while it still waits
 * for its credential.
 */
export function installManagedRunnerCredentialFetch(options: { mint?: "answered" | "outstanding" } = {}): () => void {
  let credentialSeq = 0;
  return installDaemonFetchMockForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.includes("/internal/computer/runners/") && method === "POST") {
      if (options.mint === "outstanding") return new Promise<Response>(() => {});
      credentialSeq += 1;
      return new Response(JSON.stringify({
        apiKey: `sk_agent_test_${credentialSeq}`,
        credentialId: `cred-test-${credentialSeq}`,
      }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/internal/computer/runners/") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new TypeError(`fetch failed: ${method} ${url} is not served by this test`);
  }) as typeof fetch);
}
