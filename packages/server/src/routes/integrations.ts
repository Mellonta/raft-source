import { Router, type Request, type Response, type Router as RouterType } from "express";
import { and, eq, isNull } from "drizzle-orm";
import multer from "multer";
import type { ServerCapability } from "@botiverse/raft-shared";
import { actorHasServerCapabilityInServer, getActorServerRoleInServer, roleCanInspectAgentPrivateSurfaces, userCanActOnAgentResource } from "../lib/actorPermissions";
import { getDb } from "../db/index";
import { agents, oauthClientInstalls, oauthClients } from "../db/schema";
import * as oauthService from "../services/oauthService";
import {
  AGENT_APP_EVENTS_MAX_LIMIT,
  decodeAgentAppEventCursor,
  getAgentAppEvent,
  listAgentAppEvents,
} from "../services/agentAppEventsService";
import {
  createAvatarUpload,
  PROFILE_AVATAR_BAD_FORMAT_MESSAGE,
  PROFILE_AVATAR_TOO_LARGE_MESSAGE,
} from "../services/avatarService";
import { getCdnStorage, getStorage } from "../services/storageService";
import { streamStorageResponse } from "../services/storageResponseStream";
import {
  approvePendingAppOutboundPermissionRevision,
  AppOutboundPermissionError,
  createAppOutboundPermissionRevision,
  updateAppInstallationGrant,
} from "../services/appOutboundPermissionService";
import {
  getAppNotificationDeveloperState,
  getAppNotificationInstallationState,
} from "../services/appNotificationManagementService";
import {
  AppWebhookConfigError,
  configureAppWebhook,
  disableAppWebhook,
  rotateAppWebhookSecret,
} from "../services/appWebhookConfigService";
import { oauthClientIsUserManagedPredicate } from "../services/oauthClientManagementPolicy";
import { sendJsonServerError } from "./errorResponse";

export const integrationRouter: RouterType = Router();
export const integrationInviteRouter: RouterType = Router();
export const integrationLogoPublicRouter: RouterType = Router();
const logoUpload = createAvatarUpload();

function isMarketplaceReviewer(userId: string) {
  const reviewers = (process.env.SLOCK_MARKETPLACE_REVIEWER_USER_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return reviewers.includes(userId);
}

function currentUserHasServerCapability(req: Request, capability: ServerCapability) {
  return actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, capability);
}

async function currentServerOwnsOAuthClient(req: Request, clientId: string) {
  const [client] = await getDb().select({ id: oauthClients.id }).from(oauthClients)
    .where(and(
      eq(oauthClients.id, clientId),
      eq(oauthClients.serverId, req.serverId!),
      oauthClientIsUserManagedPredicate(),
    ))
    .limit(1);
  return !!client;
}

function handleLogoUploadError(err: unknown, res: Response) {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    res.status(400).json({ error: PROFILE_AVATAR_TOO_LARGE_MESSAGE });
    return true;
  }
  if (err instanceof Error && err.message.includes(PROFILE_AVATAR_BAD_FORMAT_MESSAGE)) {
    res.status(400).json({ error: err.message });
    return true;
  }
  return false;
}

function runSingleLogoUpload(req: Request): Promise<Express.Multer.File | null> {
  return new Promise((resolve, reject) => {
    logoUpload.single("logo")(req, {} as never, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(req.file ?? null);
    });
  });
}

integrationLogoPublicRouter.get("/:clientId/:filename", async (req, res) => {
  try {
    const { clientId, filename } = req.params;
    if (!/^[0-9a-f]{32}\.webp$/.test(filename)) {
      res.status(400).json({ error: "Invalid filename" });
      return;
    }
    const contentHash = filename.slice(0, -".webp".length);
    const storageKey = await oauthService.getOAuthClientLogoStorageKey({ clientId, contentHash });
    if (!storageKey) {
      res.status(404).json({ error: "Logo not found" });
      return;
    }

    const storage = getCdnStorage() || getStorage();
    if (!storage) {
      res.status(500).json({ error: "Storage not configured" });
      return;
    }

    const stream = await storage.get(storageKey);
    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    await streamStorageResponse(stream, res);
  } catch {
    if (res.destroyed || res.headersSent) return;
    res.status(404).json({ error: "Logo not found" });
  }
});

integrationRouter.get("/overview", async (req, res) => {
  try {
    const items = await oauthService.getServerIntegrationsOverview(req.serverId!);
    res.json(items);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to load integrations overview", logPrefix: "List integrations overview error:", err });
  }
});

integrationRouter.get("/built-in", (_req, res) => {
  // Compatibility-only endpoint for cached Web clients. The retired class is
  // never queried; new clients do not call this route.
  res.json([]);
});

integrationRouter.get("/marketplace", async (req, res) => {
  try {
    const clients = await oauthService.listMarketplaceOAuthClients(req.serverId!);
    res.json(clients);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to list marketplace OAuth clients", logPrefix: "List marketplace OAuth clients error:", err });
  }
});

integrationRouter.get("/clients", async (req, res) => {
  try {
    const clients = await oauthService.listOAuthClients(req.serverId!);
    res.json(clients);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to list OAuth clients", logPrefix: "List OAuth clients error:", err });
  }
});

integrationRouter.post("/clients", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const { name, description, whenToUse, homepageUrl, returnUrl, agentManifestUrl, clientId, allowedScopes, category } = req.body ?? {};
    const created = await oauthService.createOAuthClient({
      serverId: req.serverId!,
      createdByUserId: req.userId!,
      name,
      description,
      whenToUse,
      homepageUrl,
      returnUrl,
      agentManifestUrl,
      clientId,
      allowedScopes,
      category,
    });
    res.json(created);
  } catch (err: any) {
    const message = err?.message || "Failed to create OAuth client";
    if (
      message.includes("required") ||
      message.includes("clientId") ||
      message.includes("agentManifestUrl") ||
      message.includes("scope") ||
      message.includes("category") ||
      message.includes("returnUrl") ||
      message.includes("whenToUse")
    ) {
      res.status(400).json({ error: message });
      return;
    }
    if (message.includes("duplicate key value")) {
      res.status(409).json({ error: "Client ID is already taken" });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to create OAuth client", logPrefix: "Create OAuth client error:", err });
  }
});

integrationRouter.patch("/clients/:clientId", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const { name, description, whenToUse, homepageUrl, returnUrl, agentManifestUrl, allowedScopes, category } = req.body ?? {};
    const updated = await oauthService.updateOAuthClient({
      serverId: req.serverId!,
      clientId: req.params.clientId,
      actorUserId: req.userId!,
      name,
      description,
      whenToUse,
      homepageUrl,
      returnUrl,
      agentManifestUrl,
      allowedScopes,
      category,
    });
    if (!updated) {
      res.status(404).json({ error: "OAuth client not found" });
      return;
    }
    res.json(updated);
  } catch (err: any) {
    const message = err?.message || "Failed to update OAuth client";
    if (message.includes("required") || message.includes("agentManifestUrl") || message.includes("scope") || message.includes("category") || message.includes("returnUrl") || message.includes("whenToUse")) {
      res.status(400).json({ error: message });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to update OAuth client", logPrefix: "Update OAuth client error:", err });
  }
});

integrationRouter.get("/clients/:clientId/app-notifications", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only an owner or admin of the app source server can read App Notifications settings" });
      return;
    }
    const state = await getAppNotificationDeveloperState({
      clientId: req.params.clientId,
      sourceServerId: req.serverId!,
    });
    if (!state) {
      res.status(404).json({ error: "App not found" });
      return;
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      source_installation: state.sourceInstallation ? {
        installation_id: state.sourceInstallation.id,
        status: state.sourceInstallation.status,
        enabled: state.sourceInstallation.enabled,
        approved_request_revision_id: state.sourceInstallation.approvedRequestRevisionId,
        approved_groups: state.sourceInstallation.approvedGroups,
      } : null,
      request_revision: state.requestRevision,
      current_revision_id: state.currentRevisionId,
      current_groups: state.currentGroups,
      current_events: state.currentEvents,
      pending_revision: state.pendingRevision ? {
        id: state.pendingRevision.id,
        revision: state.pendingRevision.revision,
        groups: state.pendingRevision.groups,
        events: state.pendingRevision.events,
        created_at: state.pendingRevision.createdAt,
      } : null,
      webhook: state.webhook ? {
        endpoint_url: state.webhook.endpointUrl,
        config_revision: state.webhook.revision,
        enabled: state.webhook.enabled,
        previous_valid_until: state.webhook.previousValidUntil,
        updated_at: state.webhook.updatedAt,
      } : null,
    });
  } catch (error) {
    sendJsonServerError(req, res, { error: "Failed to load App Notifications settings", logPrefix: "Read App Notifications developer state error:", err: error });
  }
});

integrationRouter.put("/clients/:clientId/app-notifications/permissions", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")
      || !await currentServerOwnsOAuthClient(req, req.params.clientId)) {
      res.status(403).json({ error: "Only an owner or admin of the app source server can update App Notifications permissions" });
      return;
    }
    const result = await createAppOutboundPermissionRevision({
      clientId: req.params.clientId,
      actor: { type: "human", id: req.userId! },
      groups: req.body?.groups,
      events: req.body?.events,
    });
    if (!result) {
      res.status(404).json({ error: "OAuth client not found" });
      return;
    }
    res.json({
      request_revision_id: result.revision.id,
      revision: result.revision.revision,
      state: result.revision.state,
      current_groups: result.currentGroups,
      current_events: result.currentEvents,
      requires_marketplace_review: result.requiresReview,
      invalidated_installation_count: result.invalidatedInstallationCount,
    });
  } catch (error) {
    if (error instanceof AppOutboundPermissionError) {
      res.status(400).json({ error: error.message });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to update App Notifications permission request", logPrefix: "Update App Notifications permission request error:", err: error });
  }
});

integrationRouter.post("/clients/:clientId/app-notifications/permissions/review", async (req, res) => {
  try {
    if (!isMarketplaceReviewer(req.userId!)) {
      res.status(403).json({ error: "Only marketplace reviewers can approve App Notifications permission expansions" });
      return;
    }
    const revision = await approvePendingAppOutboundPermissionRevision({
      clientId: req.params.clientId,
      reviewerUserId: req.userId!,
    });
    if (!revision) {
      res.status(404).json({ error: "Pending App Notifications permission revision not found" });
      return;
    }
    res.json({
      request_revision_id: revision.id,
      revision: revision.revision,
      state: revision.state,
      requested_groups: revision.requestedGroups,
      requested_events: revision.requestedEvents,
    });
  } catch (error) {
    sendJsonServerError(req, res, { error: "Failed to review App Notifications permission request", logPrefix: "Review App Notifications permission request error:", err: error });
  }
});

integrationRouter.put("/clients/:clientId/app-notifications/webhook", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")
      || !await currentServerOwnsOAuthClient(req, req.params.clientId)) {
      res.status(403).json({ error: "Only an owner or admin of the app source server can configure its webhook" });
      return;
    }
    const configured = await configureAppWebhook({
      clientId: req.params.clientId,
      actorUserId: req.userId!,
      endpointUrl: req.body?.endpointUrl ?? req.body?.endpoint_url,
    });
    if (!configured) {
      res.status(404).json({ error: "OAuth client not found" });
      return;
    }
    res.json({
      endpoint_url: configured.endpointUrl,
      config_revision: configured.revision,
      enabled: configured.enabled,
      ...(configured.secret ? { signing_secret: configured.secret } : {}),
    });
  } catch (error) {
    if (error instanceof AppWebhookConfigError) {
      res.status(400).json({ error: error.message });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to configure app webhook", logPrefix: "Configure app webhook error:", err: error });
  }
});

integrationRouter.post("/clients/:clientId/app-notifications/webhook/rotate-secret", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    if (!await currentUserHasServerCapability(req, "rotateServerSecrets")
      || !await currentServerOwnsOAuthClient(req, req.params.clientId)) {
      res.status(403).json({ error: "Only an owner or admin of the app source server can rotate its webhook secret" });
      return;
    }
    const rotated = await rotateAppWebhookSecret({
      clientId: req.params.clientId,
      actorUserId: req.userId!,
      emergency: req.body?.emergency === true,
    });
    if (!rotated) {
      res.status(404).json({ error: "Active webhook configuration not found" });
      return;
    }
    res.json({
      signing_secret: rotated.secret,
      config_revision: rotated.revision,
      previous_valid_until: rotated.previousValidUntil,
      emergency: rotated.emergency,
    });
  } catch (error) {
    if (error instanceof AppWebhookConfigError) {
      res.status(400).json({ error: error.message });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to rotate app webhook secret", logPrefix: "Rotate app webhook secret error:", err: error });
  }
});

integrationRouter.delete("/clients/:clientId/app-notifications/webhook", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")
      || !await currentServerOwnsOAuthClient(req, req.params.clientId)) {
      res.status(403).json({ error: "Only an owner or admin of the app source server can disable its webhook" });
      return;
    }
    const disabled = await disableAppWebhook({ clientId: req.params.clientId, actorUserId: req.userId! });
    if (!disabled) {
      res.status(404).json({ error: "Webhook configuration not found" });
      return;
    }
    res.json({ config_revision: disabled.revision, enabled: disabled.enabled });
  } catch (error) {
    sendJsonServerError(req, res, { error: "Failed to disable app webhook", logPrefix: "Disable app webhook error:", err: error });
  }
});

integrationRouter.post("/clients/:clientId/regenerate-secret", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "rotateServerSecrets")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const regenerated = await oauthService.regenerateClientSecretForUser({
      serverId: req.serverId!,
      clientId: req.params.clientId,
      actorUserId: req.userId!,
    });
    if (!regenerated) {
      res.status(404).json({ error: "OAuth client not found" });
      return;
    }
    res.json(regenerated);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to regenerate client secret", logPrefix: "Regenerate OAuth client secret error:", err });
  }
});

integrationRouter.post("/clients/:clientId/request-publish", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const updated = await oauthService.requestOAuthClientPublish({
      serverId: req.serverId!,
      clientId: req.params.clientId,
      requestedByUserId: req.userId!,
    });
    if (!updated) {
      res.status(404).json({ error: "OAuth client not found" });
      return;
    }
    res.json(updated);
  } catch (err: any) {
    const message = err?.message || "Failed to request marketplace publish";
    if (message.includes("description")) {
      res.status(400).json({ error: message });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to request marketplace publish", logPrefix: "Request OAuth client publish error:", err });
  }
});

integrationRouter.post("/clients/:clientId/request-unpublish", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const updated = await oauthService.requestOAuthClientUnpublish({
      serverId: req.serverId!,
      clientId: req.params.clientId,
      requestedByUserId: req.userId!,
    });
    if (!updated) {
      res.status(404).json({ error: "Published marketplace app not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to request marketplace offline review", logPrefix: "Request OAuth client unpublish error:", err });
  }
});

integrationRouter.get("/clients/:clientId/share-link", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const link = await oauthService.getOAuthClientShareLink({
      serverId: req.serverId!,
      clientId: req.params.clientId,
    });
    if (!link) {
      res.status(404).json({ error: "OAuth client share link not found" });
      return;
    }
    res.json(link);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to load private share link", logPrefix: "Get OAuth client share link error:", err });
  }
});

integrationRouter.post("/clients/:clientId/share-link", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const created = await oauthService.createOAuthClientShareLink({
      serverId: req.serverId!,
      clientId: req.params.clientId,
      createdByUserId: req.userId!,
      expiresInDays: typeof req.body?.expiresInDays === "number" ? req.body.expiresInDays : undefined,
    });
    if (!created) {
      res.status(404).json({ error: "OAuth client not found" });
      return;
    }
    res.json(created);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to create private share link", logPrefix: "Create OAuth client share link error:", err });
  }
});

integrationRouter.delete("/clients/:clientId/share-link", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const link = await oauthService.revokeOAuthClientShareLink({
      serverId: req.serverId!,
      clientId: req.params.clientId,
      revokedByUserId: req.userId!,
    });
    if (!link) {
      res.status(404).json({ error: "OAuth client share link not found" });
      return;
    }
    res.json(link);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to revoke private share link", logPrefix: "Revoke OAuth client share link error:", err });
  }
});

integrationRouter.post("/clients/:clientId/review-publish", async (req, res) => {
  try {
    if (!isMarketplaceReviewer(req.userId!)) {
      res.status(403).json({ error: "Only Raft marketplace reviewers can review listings" });
      return;
    }
    const updated = await oauthService.reviewOAuthClientPublish({
      reviewerUserId: req.userId!,
      clientId: req.params.clientId,
      status: req.body?.status,
      rejectionReason: req.body?.rejectionReason,
    });
    if (!updated) {
      res.status(404).json({ error: "OAuth client publish request not found" });
      return;
    }
    res.json(updated);
  } catch (err: any) {
    const message = err?.message || "Failed to review marketplace publish request";
    if (message.includes("review status") || message.includes("description")) {
      res.status(400).json({ error: message });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to review marketplace publish request", logPrefix: "Review OAuth client publish error:", err });
  }
});

integrationInviteRouter.get("/:token", async (req, res) => {
  try {
    const invite = await oauthService.getOAuthClientShareInvite({
      token: req.params.token,
      userId: req.userId!,
    });
    if (!invite) {
      res.status(404).json({ error: "Private app invite not found" });
      return;
    }
    res.json(invite);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to load private app invite", logPrefix: "Get OAuth client share invite error:", err });
  }
});

integrationInviteRouter.post("/:token/install", async (req, res) => {
  try {
    const serverId = typeof req.body?.serverId === "string" ? req.body.serverId.trim() : "";
    if (!serverId) {
      res.status(400).json({ error: "serverId is required" });
      return;
    }
    const invite = await oauthService.installOAuthClientShareInvite({
      token: req.params.token,
      userId: req.userId!,
      serverId,
    });
    if (!invite) {
      res.status(403).json({ error: "You can only install this app to a server you own or administer" });
      return;
    }
    res.json(invite);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to install private app invite", logPrefix: "Install OAuth client share invite error:", err });
  }
});

integrationRouter.post("/marketplace/:clientId/install", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can install marketplace apps" });
      return;
    }
    const installed = await oauthService.installMarketplaceOAuthClient({
      serverId: req.serverId!,
      clientId: req.params.clientId,
      installedByUserId: req.userId!,
    });
    if (!installed) {
      res.status(404).json({ error: "Marketplace app not found" });
      return;
    }
    res.json(installed);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to install marketplace app", logPrefix: "Install marketplace OAuth client error:", err });
  }
});

integrationRouter.get("/marketplace/:clientId/install/app-notifications", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can read installed App Notifications settings" });
      return;
    }
    const state = await getAppNotificationInstallationState({
      clientId: req.params.clientId,
      serverId: req.serverId!,
    });
    if (!state) {
      res.status(404).json({ error: "Active app installation not found" });
      return;
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      installation_id: state.installationId,
      status: state.status,
      approved_request_revision_id: state.approvedRequestRevisionId,
      requested_groups: state.requestedGroups,
      requested_events: state.requestedEvents,
      approved_groups: state.approvedGroups,
      subscribed_events: state.subscribedEvents,
      effective_groups: state.effective.groups,
      effective_events: state.effective.events,
      grant_revision: state.grantRevision,
      subscription_revision: state.subscriptionRevision,
      app_review_pending: !!state.pendingRevisionId,
      approval_required: state.approvalRequired,
    });
  } catch (error) {
    sendJsonServerError(req, res, { error: "Failed to load installed App Notifications settings", logPrefix: "Read installed App Notifications state error:", err: error });
  }
});

integrationRouter.put("/marketplace/:clientId/install/app-notifications/grant", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can approve App Notifications permissions" });
      return;
    }
    const [install] = await getDb().select({ id: oauthClientInstalls.id })
      .from(oauthClientInstalls)
      .where(and(
        eq(oauthClientInstalls.serverId, req.serverId!),
        eq(oauthClientInstalls.clientId, req.params.clientId),
        eq(oauthClientInstalls.status, "active"),
      )).limit(1);
    if (!install) {
      res.status(404).json({ error: "Active app installation not found" });
      return;
    }
    const updated = await updateAppInstallationGrant({
      installationId: install.id,
      actorUserId: req.userId!,
    });
    if (!updated) {
      res.status(404).json({ error: "Active app installation not found" });
      return;
    }
    res.json({
      installation_id: updated.id,
      approved_request_revision_id: updated.approvedRequestRevisionId,
      approved_groups: updated.approvedGroups,
      subscribed_events: updated.subscribedEvents,
      grant_revision: updated.grantRevision,
      subscription_revision: updated.subscriptionRevision,
    });
  } catch (error) {
    if (error instanceof AppOutboundPermissionError) {
      res.status(400).json({ error: error.message });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to update installed App Notifications permissions", logPrefix: "Update installed App Notifications permissions error:", err: error });
  }
});

integrationRouter.delete("/marketplace/:clientId/install", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can uninstall marketplace apps" });
      return;
    }
    const result = await oauthService.uninstallMarketplaceOAuthClient({
      serverId: req.serverId!,
      clientId: req.params.clientId,
      revokedByUserId: req.userId!,
    });
    if (!result) {
      res.status(404).json({ error: "Marketplace app not found" });
      return;
    }
    res.json(result);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to uninstall marketplace app", logPrefix: "Uninstall marketplace OAuth client error:", err });
  }
});

integrationRouter.post("/clients/:clientId/logo", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const file = await runSingleLogoUpload(req);
    if (!file) {
      res.status(400).json({ error: "No logo file provided" });
      return;
    }
    const updated = await oauthService.updateOAuthClientLogo({
      serverId: req.serverId!,
      clientId: req.params.clientId,
      fileBuffer: file.buffer,
      actorUserId: req.userId!,
    });
    if (!updated) {
      res.status(404).json({ error: "OAuth client not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    if (handleLogoUploadError(err, res)) return;
    sendJsonServerError(req, res, { error: "Failed to upload OAuth client logo", logPrefix: "Upload OAuth client logo error:", err });
  }
});

integrationRouter.delete("/clients/:clientId/logo", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const updated = await oauthService.clearOAuthClientLogo({
      serverId: req.serverId!,
      clientId: req.params.clientId,
      actorUserId: req.userId!,
    });
    if (!updated) {
      res.status(404).json({ error: "OAuth client not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to clear OAuth client logo", logPrefix: "Clear OAuth client logo error:", err });
  }
});

integrationRouter.delete("/clients/:clientId", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const deleted = await oauthService.deleteOAuthClient({
      serverId: req.serverId!,
      clientId: req.params.clientId,
      deletedByUserId: req.userId!,
    });
    if (!deleted) {
      res.status(404).json({ error: "OAuth client not found" });
      return;
    }
    res.json(deleted);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to delete OAuth client", logPrefix: "Delete OAuth client error:", err });
  }
});

/**
 * Agent access by an app is managed by server owners/admins and by the
 * agent's own creator.
 */
async function canManageAgentAccess(
  req: Request,
  agent: { creatorType: string | null; creatorId: string | null } | null,
): Promise<boolean> {
  // Role read fresh (not the request's cached one): a removed or demoted member
  // loses this at once, the same as for the capability path.
  const role = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
  if (!role) return false;
  return userCanActOnAgentResource(role, req.userId!, agent ?? { creatorType: null, creatorId: null }, "manageExternalAuth");
}

integrationRouter.post("/requests/:requestId/approve", async (req, res) => {
  try {
    if (!await canManageAgentAccess(req, await oauthService.getAgentForAccessRequest(req.serverId!, req.params.requestId))) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const remember = !!req.body?.remember;
    const result = await oauthService.approveAccessRequest({
      serverId: req.serverId!,
      requestId: req.params.requestId,
      resolvedByUserId: req.userId!,
      remember,
    });
    res.json(result);
  } catch (err: any) {
    const message = err?.message || "Failed to approve request";
    if (message.includes("not found")) {
      res.status(404).json({ error: message });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to approve integration request", logPrefix: "Approve integration request error:", err });
  }
});

integrationRouter.post("/requests/:requestId/deny", async (req, res) => {
  try {
    if (!await canManageAgentAccess(req, await oauthService.getAgentForAccessRequest(req.serverId!, req.params.requestId))) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const updated = await oauthService.denyAccessRequest({
      serverId: req.serverId!,
      requestId: req.params.requestId,
      resolvedByUserId: req.userId!,
    });
    if (!updated) {
      res.status(404).json({ error: "Access request not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to deny integration request", logPrefix: "Deny integration request error:", err });
  }
});

integrationRouter.post("/grants/:grantId/revoke", async (req, res) => {
  try {
    if (!await canManageAgentAccess(req, await oauthService.getAgentForGrant(req.serverId!, req.params.grantId))) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const updated = await oauthService.revokeGrant({
      serverId: req.serverId!,
      grantId: req.params.grantId,
      revokedByUserId: req.userId!,
    });
    if (!updated) {
      res.status(404).json({ error: "Grant not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to revoke integration grant", logPrefix: "Revoke integration grant error:", err });
  }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The agent in the active server, or null after answering 404. */
async function loadAgentInServer(req: Request, res: Response) {
  const agentId = String(req.params.agentId);
  if (!UUID_RE.test(agentId)) {
    res.status(404).json({ error: "Agent not found" });
    return null;
  }
  const [agent] = await getDb().select({
    id: agents.id,
    serverId: agents.serverId,
    creatorType: agents.creatorType,
    creatorId: agents.creatorId,
  }).from(agents).where(and(eq(agents.id, agentId), isNull(agents.deletedAt))).limit(1);
  if (!agent || agent.serverId !== req.serverId) {
    res.status(404).json({ error: "Agent not found" });
    return null;
  }
  return agent;
}

/**
 * The agent when the caller may see its private surfaces (its creator, or a
 * server owner/admin), else null after answering 404/403.
 */
async function loadInspectableAgent(req: Request, res: Response): Promise<{ id: string } | null> {
  const agent = await loadAgentInServer(req, res);
  if (!agent) return null;
  const role = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
  if (!role || !roleCanInspectAgentPrivateSurfaces(role, req.userId!, agent)) {
    res.status(403).json({ error: "Only the agent's creator and server owners and admins can view its app events" });
    return null;
  }
  return agent;
}

// Events connected apps sent to this agent, newest first (Agent panel).
integrationRouter.get("/agents/:agentId/events", async (req, res) => {
  try {
    const agent = await loadInspectableAgent(req, res);
    if (!agent) return;
    const { clientId, before, limit } = req.query;
    if (clientId !== undefined && (typeof clientId !== "string" || !UUID_RE.test(clientId))) {
      res.status(400).json({ error: "clientId must be an app id" });
      return;
    }
    let cursor: { createdAt: Date; id: string } | undefined;
    if (before !== undefined) {
      cursor = typeof before === "string" ? decodeAgentAppEventCursor(before) ?? undefined : undefined;
      if (!cursor) {
        res.status(400).json({ error: "before must be a cursor returned by this endpoint" });
        return;
      }
    }
    let pageSize: number | undefined;
    if (limit !== undefined) {
      pageSize = typeof limit === "string" && /^\d+$/.test(limit) ? Number(limit) : Number.NaN;
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > AGENT_APP_EVENTS_MAX_LIMIT) {
        res.status(400).json({ error: `limit must be an integer from 1 to ${AGENT_APP_EVENTS_MAX_LIMIT}` });
        return;
      }
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.json(await listAgentAppEvents({ agentId: agent.id, clientId, before: cursor, limit: pageSize }));
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to load agent app events", logPrefix: "List agent app events error:", err });
  }
});

integrationRouter.get("/agents/:agentId/events/:eventId", async (req, res) => {
  try {
    const agent = await loadInspectableAgent(req, res);
    if (!agent) return;
    const event = await getAgentAppEvent({ agentId: agent.id, eventId: req.params.eventId });
    if (!event) {
      res.status(404).json({ error: "Event not found" });
      return;
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.json(event);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to load agent app event", logPrefix: "Read agent app event error:", err });
  }
});

// Apps the caller may grant to this agent (picker for the on-behalf grant).
integrationRouter.get("/agents/:agentId/grantable-apps", async (req, res) => {
  try {
    const agent = await loadAgentInServer(req, res);
    if (!agent) return;
    if (!await canManageAgentAccess(req, agent)) {
      res.status(403).json({ error: "Only the agent's creator and server owners and admins can grant app access" });
      return;
    }
    res.json({ apps: await oauthService.listGrantableAgentApps(req.serverId!) });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to load grantable apps", logPrefix: "List grantable agent apps error:", err });
  }
});

// A person grants an app access to this agent without the agent asking.
integrationRouter.post("/agents/:agentId/grants", async (req, res) => {
  try {
    const agent = await loadAgentInServer(req, res);
    if (!agent) return;
    if (!await canManageAgentAccess(req, agent)) {
      res.status(403).json({ error: "Only the agent's creator and server owners and admins can grant app access" });
      return;
    }
    const { clientId, scopes } = req.body ?? {};
    if (typeof clientId !== "string" || !UUID_RE.test(clientId)) {
      res.status(400).json({ error: "clientId must be an app id" });
      return;
    }
    const result = await oauthService.grantAgentAccessOnBehalf({
      serverId: req.serverId!,
      agentId: agent.id,
      clientId,
      scopes,
      grantedByUserId: req.userId!,
    });
    res.status(result.created ? 201 : 200).json(result);
  } catch (err) {
    if (err instanceof oauthService.AgentAccessGrantError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to grant app access", logPrefix: "Grant agent app access error:", err });
  }
});

integrationRouter.get("/agents/:agentId", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "viewAgents")) {
      res.status(403).json({ error: "Only server owners and admins can view agent integrations" });
      return;
    }

    const db = getDb();
    const [agent] = await db.select({ id: agents.id, serverId: agents.serverId }).from(agents).where(eq(agents.id, req.params.agentId)).limit(1);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const items = await oauthService.getAgentIntegrationsOverview(req.params.agentId);
    res.json(items);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to load agent integrations", logPrefix: "List agent integrations error:", err });
  }
});
