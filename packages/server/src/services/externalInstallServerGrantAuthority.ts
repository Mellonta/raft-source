import { and, eq } from "drizzle-orm";

import type { DatabaseExecutor } from "../db/index";
import {
  externalAppInstallServerGrants,
  externalAppServerGrants,
} from "../db/schema";

export interface ExternalInstallServerGrantCoordinate {
  installId: string;
  serverId: string;
  registrationId: string;
}

type Association = typeof externalAppInstallServerGrants.$inferSelect;
type Grant = typeof externalAppServerGrants.$inferSelect;

export type ExternalInstallServerGrantAuthorityDecision =
  | { current: false; reason: "missing_or_inactive" }
  | { current: false; reason: "epoch_mismatch"; association: Association; grant: Grant }
  | { current: true; association: Association; grant: Grant };

/**
 * Resolves the one current Raft-server grant attached to a workspace install.
 * Every consumer of the shared-install association must use this complete
 * identity + state + epoch fence before provider I/O or authority mutation.
 */
export async function resolveExternalInstallServerGrantAuthority(
  executor: DatabaseExecutor,
  coordinate: ExternalInstallServerGrantCoordinate,
  options: { lock?: boolean } = {},
): Promise<ExternalInstallServerGrantAuthorityDecision> {
  const query = executor.select({
    association: externalAppInstallServerGrants,
    grant: externalAppServerGrants,
  }).from(externalAppInstallServerGrants)
    .innerJoin(externalAppServerGrants, and(
      eq(externalAppServerGrants.id, externalAppInstallServerGrants.serverGrantId),
      eq(externalAppServerGrants.serverId, externalAppInstallServerGrants.serverId),
      eq(externalAppServerGrants.registrationId, externalAppInstallServerGrants.registrationId),
    ))
    .where(and(
      eq(externalAppInstallServerGrants.installId, coordinate.installId),
      eq(externalAppInstallServerGrants.serverId, coordinate.serverId),
      eq(externalAppInstallServerGrants.registrationId, coordinate.registrationId),
      eq(externalAppInstallServerGrants.state, "active"),
      eq(externalAppServerGrants.state, "active"),
    ))
    .limit(2);
  const rows = options.lock ? await query.for("update") : await query;
  if (rows.length !== 1) return { current: false, reason: "missing_or_inactive" };
  const row = rows[0]!;
  if (row.association.grantEpoch !== row.grant.grantEpoch) {
    return { current: false, reason: "epoch_mismatch", ...row };
  }
  return { current: true, ...row };
}

export async function findAnyCurrentExternalInstallServerGrantAuthority(
  executor: DatabaseExecutor,
  input: { installId: string; registrationId: string },
  options: { lock?: boolean } = {},
): Promise<Extract<ExternalInstallServerGrantAuthorityDecision, { current: true }> | null> {
  const query = executor.select({
    serverId: externalAppInstallServerGrants.serverId,
  }).from(externalAppInstallServerGrants).where(and(
    eq(externalAppInstallServerGrants.installId, input.installId),
    eq(externalAppInstallServerGrants.registrationId, input.registrationId),
    eq(externalAppInstallServerGrants.state, "active"),
  ));
  const associations = options.lock ? await query.for("update") : await query;
  for (const association of associations) {
    const decision = await resolveExternalInstallServerGrantAuthority(executor, {
      installId: input.installId,
      serverId: association.serverId,
      registrationId: input.registrationId,
    }, options);
    if (decision.current) return decision;
  }
  return null;
}
