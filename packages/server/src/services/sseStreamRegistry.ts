import type { ServerResponse } from "node:http";

/**
 * Registry of open SSE (text/event-stream) responses so the going-away
 * phase can end them deliberately instead of letting the shutdown deadline
 * sever them mid-stream (task #261).
 *
 * SSE responses are in-flight requests that never finish on their own, so
 * `server.close()` would otherwise hang on them until the process is killed.
 * Ending the stream here lets the client reconnect immediately against a
 * healthy task.
 */
export interface SseStreamRegistry {
  register(res: ServerResponse): void;
  unregister(res: ServerResponse): void;
  /** End every registered stream. Returns how many were open. */
  endAll(): number;
  readonly size: number;
}

export function createSseStreamRegistry(): SseStreamRegistry {
  const streams = new Set<ServerResponse>();
  return {
    register(res) {
      streams.add(res);
    },
    unregister(res) {
      streams.delete(res);
    },
    endAll() {
      const count = streams.size;
      for (const res of [...streams]) {
        streams.delete(res);
        if (!res.writableEnded) res.end();
      }
      return count;
    },
    get size() {
      return streams.size;
    },
  };
}

/**
 * Process-wide registry used by the HTTP routes and the drain going-away
 * phase. Module-level because the route routers are themselves module-level
 * singletons.
 */
export const sharedSseStreamRegistry: SseStreamRegistry = createSseStreamRegistry();
