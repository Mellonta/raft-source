// Environment for a CLI child process spawned by a test.
//
// A test that runs the real CLI must talk only to the test server, with the
// identity it passes in. Inheriting the outer process's RAFT_*/SLOCK_* variables
// breaks that when the suite itself runs inside a hosted agent runtime: the
// child picks up that runtime's managed transport, home, profile and agent
// identity instead. So every RAFT_*/SLOCK_* key is dropped first, and only the
// test's own values are applied on top.
export function cliChildEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(RAFT|SLOCK)_/.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...overrides };
}
