import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

import { externalAppRegistrations, oauthClients } from "../db/schema";

/**
 * External-app registrations are the canonical platform lifecycle authority
 * for provider bridges. Their OAuth client is only an identity anchor. The
 * historical `slock_builtin` value is also a compatibility tombstone: no
 * current Connected App surface may expose or operate it.
 *
 * Keep this policy derived from the existing restrictive FK. A second mutable
 * "managed" flag would create two authorities which can drift.
 */
export function oauthClientIsPlatformManagedPredicate(): SQL<boolean> {
  return oauthClientIdIsPlatformManagedPredicate(oauthClients.id);
}

export function oauthClientIdIsPlatformManagedPredicate(clientId: SQLWrapper): SQL<boolean> {
  return sql<boolean>`exists (
    select 1
    from ${externalAppRegistrations} platform_registration
    where platform_registration.oauth_client_id = ${clientId}
  )`;
}

export function oauthClientIsUserManagedPredicate(): SQL<boolean> {
  return sql<boolean>`
    ${oauthClients.appType} <> 'slock_builtin'
    and not (${oauthClientIsPlatformManagedPredicate()})
  `;
}

export function oauthClientIdIsUserManagedPredicate(clientId: SQLWrapper): SQL<boolean> {
  return sql<boolean>`exists (
    select 1
    from "oauth_clients" eligible_oauth_client
    where eligible_oauth_client."id" = ${clientId}
      and eligible_oauth_client."app_type" <> 'slock_builtin'
      and not exists (
        select 1
        from ${externalAppRegistrations} platform_registration
        where platform_registration.oauth_client_id = eligible_oauth_client."id"
      )
  )`;
}
