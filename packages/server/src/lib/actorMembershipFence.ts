import { sql } from "drizzle-orm";
import type { ServerRole } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor, type DatabaseTransaction } from "../db/index";

/**
 * Thrown inside a fenced write when the acting human no longer holds a membership row
 * in the Server. Routes map it to the same 403 body the request-level membership guard
 * returns, so a departure that lands mid-request looks identical to one that landed first.
 */
export class ServerMembershipRevokedError extends Error {
  readonly code = "server_membership_revoked" as const;

  constructor(readonly serverId: string, readonly userId: string) {
    super("Not a member of this server");
    this.name = "ServerMembershipRevokedError";
  }
}

/**
 * Thrown inside a fenced write when re-authorization under the locked role fails, or the resource vanished
 * before its row lock was taken. Throwing (rather than returning) rolls the transaction back.
 */
export class FencedAuthorizationDeniedError extends Error {
  readonly code = "fenced_authorization_denied" as const;

  constructor(readonly reason: "forbidden" | "not_found" = "forbidden") {
    super(reason === "not_found" ? "Resource not found" : "Not authorized");
    this.name = "FencedAuthorizationDeniedError";
  }
}

/**
 * Lock the actor's own `server_members` row inside an existing transaction and return the role read under
 * that lock (task #91, matrix R02/R04 atomicity). Throws ServerMembershipRevokedError when the row is gone.
 *
 * - `share` (`FOR SHARE`, never `FOR KEY SHARE`): removal (DELETE) and role transitions (UPDATE, taken
 *   `FOR UPDATE` by transitionMemberRole) both conflict with it, so they wait for this write to commit;
 *   if they committed first, the row is gone or already carries the new role.
 * - `update` (`FOR UPDATE`): only for a transaction that later updates this same member row, so it never
 *   upgrades a share lock it holds (two such writers would deadlock on the upgrade).
 * - Global lock order: the `servers` row when the write itself needs it (the #4883 owner-setup ordering is
 *   servers → server_members), then this member row, then Agent / Machine / Computer resource rows.
 *   Resource row locks are never taken before this call.
 */
export async function lockActorMembershipRow(
  tx: DatabaseExecutor,
  serverId: string,
  userId: string,
  mode: "share" | "update" = "share",
): Promise<ServerRole> {
  const locked = mode === "update"
    ? await tx.execute(sql`
      SELECT role
      FROM server_members
      WHERE server_id = ${serverId}
        AND user_id = ${userId}
      FOR UPDATE
    `)
    : await tx.execute(sql`
      SELECT role
      FROM server_members
      WHERE server_id = ${serverId}
        AND user_id = ${userId}
      FOR SHARE
    `);
  const row = locked.rows[0] as { role: ServerRole } | undefined;
  if (!row) throw new ServerMembershipRevokedError(serverId, userId);
  return row.role;
}

/**
 * Run an authority-bearing write in one transaction that first takes a shared row lock on
 * the actor's own `server_members` row (see lockActorMembershipRow for lock mode and order).
 *
 * - `run` receives the role read under the lock and must re-evaluate the full authorization
 *   predicate with it (capability by role OR exact creator/registrant relation). A role read
 *   before the transaction is not evidence.
 * - `run` must take any Agent/Machine row locks itself, after the member lock, never before it.
 * - Shared locks do not conflict with each other, so concurrent writers never block each other.
 * - Runtime commands sent after this transaction commits are NOT covered by this fence.
 */
export async function withActorMembershipFence<T>(
  serverId: string,
  userId: string,
  run: (tx: DatabaseTransaction, role: ServerRole) => Promise<T>,
): Promise<T> {
  return getDb().transaction(async (tx) => run(tx, await lockActorMembershipRow(tx, serverId, userId, "share")));
}
