/**
 * Web route for private integration-app share links. The web app routes
 * {@link INTEGRATION_INVITE_ROUTE}; every producer of a share URL (Settings,
 * agent API) must go through {@link integrationInvitePath} /
 * {@link buildIntegrationInviteUrl} so the emitted link always matches it.
 */
export const INTEGRATION_INVITE_PATH_PREFIX = "/integration-invites";

export const INTEGRATION_INVITE_ROUTE = `${INTEGRATION_INVITE_PATH_PREFIX}/:token`;

export function integrationInvitePath(token: string): string {
  return `${INTEGRATION_INVITE_PATH_PREFIX}/${encodeURIComponent(token)}`;
}

export function buildIntegrationInviteUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, "")}${integrationInvitePath(token)}`;
}
