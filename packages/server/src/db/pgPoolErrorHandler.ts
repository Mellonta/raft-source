import type pg from "pg";

// Crash guard (task #269, prod incident 2026-09-29 16:35:44Z): pg-pool removes
// its own idle-client 'error' listener while a client is checked out
// (_acquireClient removes the idleListener reference and re-adds it only on
// release). If the server drops the connection while a checked-out client
// sits between queries — e.g. inside a drizzle transaction() — pg's
// _handleErrorWhileConnected emits 'error' on the Client with no listener,
// and the process dies with "Unhandled 'error' event on Client instance".
// That incident: Neon dropped every connection in one second; the 1 of 12
// tasks that was mid-transaction exited code 1 (ELB 502/504 spike, self-
// recovered on replacement).
//
// Attaching our own listener once per client at pool 'connect' time survives
// checkout, because pg-pool removes only its own listener reference. An
// in-flight query still receives the same error through its own callback —
// this listener's only job is to keep the process alive and record the event.
export function attachPoolClientErrorHandler(pool: pg.Pool, label: string): void {
  pool.on("connect", (client) => {
    client.on("error", (err: Error) => {
      console.error(
        `[${label}] pg client error on a checked-out connection (connection dropped between queries):`,
        err.message,
      );
    });
  });
}
