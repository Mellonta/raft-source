// Select once by deployment configuration; database errors never trigger a
// silent fallback. Upstream's RisingWave deployment remains the default.
export function usesPostgresReadBackend(env: NodeJS.ProcessEnv = process.env): boolean {
  const backend = env.RAFT_READ_BACKEND?.trim() || "risingwave";
  if (backend !== "postgres" && backend !== "risingwave") {
    throw new Error("RAFT_READ_BACKEND must be postgres or risingwave");
  }
  if (backend === "postgres" && env.RISINGWAVE_DATABASE_URL?.trim()) {
    throw new Error("RAFT_READ_BACKEND=postgres cannot be combined with RISINGWAVE_DATABASE_URL");
  }
  return backend === "postgres";
}
