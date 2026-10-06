import type { NextFunction, Request, Response, Router } from "express";
import { UUID_RE } from "./messageId";

/**
 * Uniform 404 for non-UUID path parameters (task #12).
 *
 * A mistyped or garbage path segment (e.g. `/api/channels/threads` falling
 * through to `/channels/:id`) names no resource; letting it reach the query
 * layer raises a Postgres uuid-cast error and comes back as a 500. Registering
 * a guard per param name via `router.param` makes every matching route answer
 * 404 before its handler runs:
 *
 *   guardUuidPathParams(channelRouter, { id: "Channel", inviteId: "Invite" });
 *
 * Only register params that are UUID-typed on EVERY route of that router
 * (e.g. never `taskNumber` or `targetType`). The check uses the shared
 * UUID_RE (shape-only, any version nibble): a well-formed but unknown UUID
 * reaches the handler and gets the resource's ordinary not-found path, which
 * is the same 404 either way.
 */
export function guardUuidPathParams(
  router: Router,
  params: Readonly<Record<string, string>>,
): void {
  for (const [name, resource] of Object.entries(params)) {
    router.param(name, (req: Request, res: Response, next: NextFunction, value: unknown) => {
      if (typeof value !== "string" || !UUID_RE.test(value)) {
        res.status(404).json({ error: `${resource} not found` });
        return;
      }
      next();
    });
  }
}
