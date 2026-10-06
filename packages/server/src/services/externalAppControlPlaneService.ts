import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull, ne, or } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import {
  channels,
  externalAppCredentials,
  externalAppInstallGrantReceipts,
  externalAppInstallServerGrants,
  externalAppInstalls,
  externalAppRegistrationSecrets,
  externalAppRegistrations,
  externalAppServerGrants,
  externalBindingAudienceSnapshots,
  externalChannelBindings,
  externalHumanIdentityLinks,
  externalOAuthAttempts,
  oauthClientInstalls,
  serverMembers,
  servers,
} from "../db/schema";
import { resolveExternalConversationTarget } from "./externalConversationTargetService";
import { slackBridgeInstallGrantHash } from "./slackBridgeInstallGrantService";
import { resolveExternalInstallServerGrantAuthority } from "./externalInstallServerGrantAuthority";

const EXTERNAL_OAUTH_ATTEMPT_TTL_MS = 10 * 60_000;

type DbLike = ReturnType<typeof getDb>;
type RegistrationRow = typeof externalAppRegistrations.$inferSelect;
type GrantRow = typeof externalAppServerGrants.$inferSelect;

export type ExternalAppControlPlaneErrorCode =
  | "external_app_not_authorized"
  | "external_app_invalid_state"
  | "external_app_install_conflict"
  | "external_app_scope_mismatch"
  | "external_app_persist_failed";

export class ExternalAppControlPlaneError extends Error {
  constructor(
    message: string,
    readonly code: ExternalAppControlPlaneErrorCode,
  ) {
    super(message);
    this.name = "ExternalAppControlPlaneError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function sameStrings(left: string[], right: string[]): boolean {
  const a = canonicalStrings(left);
  const b = canonicalStrings(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function loadCurrentGrant(
  tx: DbLike,
  input: {
    serverId: string;
    registrationId: string;
    serverGrantId: string;
    grantEpoch: number;
    requestingUserId?: string;
    lock?: boolean;
  },
): Promise<{ registration: RegistrationRow; grant: GrantRow }> {
  const registrationQuery = tx
    .select()
    .from(externalAppRegistrations)
    .where(and(
      eq(externalAppRegistrations.id, input.registrationId),
      eq(externalAppRegistrations.state, "active"),
    ))
    .limit(1);
  const [registration] = input.lock
    ? await registrationQuery.for("update")
    : await registrationQuery;
  if (!registration) {
    throw new ExternalAppControlPlaneError(
      "External app authority is unavailable",
      "external_app_not_authorized",
    );
  }

  const grantQuery = tx
    .select()
    .from(externalAppServerGrants)
    .where(and(
      eq(externalAppServerGrants.id, input.serverGrantId),
      eq(externalAppServerGrants.serverId, input.serverId),
      eq(externalAppServerGrants.registrationId, registration.id),
      eq(externalAppServerGrants.state, "active"),
      eq(externalAppServerGrants.grantEpoch, input.grantEpoch),
    ))
    .limit(1);
  const [grant] = input.lock ? await grantQuery.for("update") : await grantQuery;
  if (
    !grant
    || grant.grantedManifestVersion !== registration.capabilityManifestVersion
    || grant.grantedManifestHash !== registration.capabilityManifestHash
    || !sameStrings(grant.grantedCapabilities, registration.requiredCapabilities)
  ) {
    throw new ExternalAppControlPlaneError(
      "External app grant is stale or revoked",
      "external_app_not_authorized",
    );
  }

  const presenceQuery = tx
    .select({ id: oauthClientInstalls.id })
    .from(oauthClientInstalls)
    .where(and(
      eq(oauthClientInstalls.serverId, input.serverId),
      eq(oauthClientInstalls.clientId, registration.oauthClientId),
    ))
    .limit(1);
  const [presence] = input.lock
    ? await presenceQuery.for("update")
    : await presenceQuery;
  if (!presence) {
    throw new ExternalAppControlPlaneError(
      "External app installation is not present",
      "external_app_not_authorized",
    );
  }

  if (input.requestingUserId) {
    const membershipQuery = tx
      .select({ role: serverMembers.role })
      .from(serverMembers)
      .where(and(
        eq(serverMembers.serverId, input.serverId),
        eq(serverMembers.userId, input.requestingUserId),
      ))
      .limit(1);
    const [membership] = input.lock
      ? await membershipQuery.for("update")
      : await membershipQuery;
    if (membership?.role !== "owner" && membership?.role !== "admin") {
      throw new ExternalAppControlPlaneError(
        "External app operation is not authorized",
        "external_app_not_authorized",
      );
    }
  }

  return { registration, grant };
}

export async function beginExternalOAuthAttempt(input: {
  serverId: string;
  registrationId: string;
  serverGrantId: string;
  grantEpoch: number;
  requestingUserId: string;
  redirectUri: string;
  requestedScopes: string[];
  grantIntent: string;
}): Promise<{
  attemptId: string;
  state: string;
  expiresAt: Date;
  environment: "test" | "production";
  providerAppId: string;
  providerOAuthClientId: string;
}> {
  const state = randomBytes(32).toString("base64url");
  const stateHash = sha256(state);
  const now = currentDate();
  const expiresAt = new Date(now.getTime() + EXTERNAL_OAUTH_ATTEMPT_TTL_MS);

  const attempt = await getDb().transaction(async (tx) => {
    const { registration } = await loadCurrentGrant(tx as DbLike, {
      ...input,
      lock: true,
    });
    const requestedScopes = canonicalStrings(input.requestedScopes);
    if (!input.redirectUri || !requestedScopes.length || !input.grantIntent) {
      throw new ExternalAppControlPlaneError(
        "External OAuth request is incomplete",
        "external_app_invalid_state",
      );
    }

    const [created] = await tx
      .insert(externalOAuthAttempts)
      .values({
        serverId: input.serverId,
        registrationId: registration.id,
        serverGrantId: input.serverGrantId,
        grantEpoch: input.grantEpoch,
        requestingUserId: input.requestingUserId,
        stateHash,
        environment: registration.environment,
        redirectUri: input.redirectUri,
        requestedScopes,
        manifestVersion: registration.capabilityManifestVersion,
        manifestHash: registration.capabilityManifestHash,
        grantIntentHash: sha256(input.grantIntent),
        expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: externalOAuthAttempts.id });
    if (!created) {
      throw new ExternalAppControlPlaneError(
        "External OAuth attempt could not be persisted",
        "external_app_persist_failed",
      );
    }
    return {
      attemptId: created.id,
      environment: registration.environment,
      providerAppId: registration.providerAppId,
      providerOAuthClientId: registration.providerOAuthClientId,
    };
  });

  return { ...attempt, state, expiresAt };
}

export async function claimExternalOAuthAttempt(input: {
  state: string;
  expectedEnvironment: "test" | "production";
  expectedRedirectUri: string;
}): Promise<{
  attemptId: string;
  serverId: string;
  registrationId: string;
  requestingUserId: string;
  requestedScopes: string[];
  environment: "test" | "production";
  providerAppId: string;
  providerOAuthClientId: string;
}> {
  const stateHash = sha256(input.state);
  const now = currentDate();

  return getDb().transaction(async (tx) => {
    const [attempt] = await tx
      .select()
      .from(externalOAuthAttempts)
      .where(and(
        eq(externalOAuthAttempts.stateHash, stateHash),
        eq(externalOAuthAttempts.status, "pending"),
        gt(externalOAuthAttempts.expiresAt, now),
      ))
      .limit(1)
      .for("update");
    if (
      !attempt
      || attempt.environment !== input.expectedEnvironment
      || attempt.redirectUri !== input.expectedRedirectUri
    ) {
      throw new ExternalAppControlPlaneError(
        "External OAuth state is invalid",
        "external_app_invalid_state",
      );
    }

    const { registration } = await loadCurrentGrant(tx as DbLike, {
      serverId: attempt.serverId,
      registrationId: attempt.registrationId,
      serverGrantId: attempt.serverGrantId,
      grantEpoch: attempt.grantEpoch,
      requestingUserId: attempt.requestingUserId,
      lock: true,
    });
    if (
      attempt.manifestVersion !== registration.capabilityManifestVersion
      || attempt.manifestHash !== registration.capabilityManifestHash
      || attempt.environment !== registration.environment
    ) {
      throw new ExternalAppControlPlaneError(
        "External OAuth authority changed",
        "external_app_not_authorized",
      );
    }

    const [claimed] = await tx
      .update(externalOAuthAttempts)
      .set({
        status: "exchanging",
        exchangeStartedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(externalOAuthAttempts.id, attempt.id),
        eq(externalOAuthAttempts.status, "pending"),
      ))
      .returning({ id: externalOAuthAttempts.id });
    if (!claimed) {
      throw new ExternalAppControlPlaneError(
        "External OAuth state is invalid",
        "external_app_invalid_state",
      );
    }

    return {
      attemptId: attempt.id,
      serverId: attempt.serverId,
      registrationId: attempt.registrationId,
      requestingUserId: attempt.requestingUserId,
      requestedScopes: [...attempt.requestedScopes],
      environment: registration.environment,
      providerAppId: registration.providerAppId,
      providerOAuthClientId: registration.providerOAuthClientId,
    };
  });
}

export interface SealedExternalCredential {
  encryptedMaterial: string;
  envelopeKeyId: string;
  aadVersion: number;
  expiresAt?: Date | null;
}

async function persistExternalHumanIdentityLink(
  tx: DbLike,
  input: {
    serverId: string;
    installId: string;
    userId: string;
    providerAuthorityId: string;
    providerUserId: string;
    observedConnectionEpoch: number;
    now: Date;
  },
): Promise<{ id: string; linkEpoch: number }> {
  const active = await tx
    .select()
    .from(externalHumanIdentityLinks)
    .where(and(
      eq(externalHumanIdentityLinks.installId, input.installId),
      eq(externalHumanIdentityLinks.state, "active"),
      or(
        eq(externalHumanIdentityLinks.userId, input.userId),
        eq(externalHumanIdentityLinks.providerUserId, input.providerUserId),
      ),
    ))
    .for("update");
  const providerConflict = active.find((link) =>
    link.providerUserId === input.providerUserId
      && link.userId !== input.userId);
  if (providerConflict) {
    throw new ExternalAppControlPlaneError(
      "Slack human identity is already linked to another Raft user",
      "external_app_install_conflict",
    );
  }

  const same = active.find((link) =>
    link.userId === input.userId
      && link.providerUserId === input.providerUserId);
  const replaced = active.filter((link) =>
    link.userId === input.userId
      && link.providerUserId !== input.providerUserId);
  for (const link of replaced) {
    await tx
      .update(externalHumanIdentityLinks)
      .set({
        state: "revoked",
        revokedAt: input.now,
        revokeReason: "provider_identity_replaced",
        updatedAt: input.now,
      })
      .where(and(
        eq(externalHumanIdentityLinks.id, link.id),
        eq(externalHumanIdentityLinks.state, "active"),
        eq(externalHumanIdentityLinks.linkEpoch, link.linkEpoch),
      ));
  }

  const [latest] = await tx
    .select({ linkEpoch: externalHumanIdentityLinks.linkEpoch })
    .from(externalHumanIdentityLinks)
    .where(and(
      eq(externalHumanIdentityLinks.installId, input.installId),
      eq(externalHumanIdentityLinks.userId, input.userId),
    ))
    .orderBy(desc(externalHumanIdentityLinks.linkEpoch))
    .limit(1);
  const linkEpoch = (latest?.linkEpoch ?? 0) + 1;
  if (same) {
    const [updated] = await tx
      .update(externalHumanIdentityLinks)
      .set({
        serverId: input.serverId,
        providerAuthorityId: input.providerAuthorityId,
        linkEpoch,
        observedConnectionEpoch: input.observedConnectionEpoch,
        updatedAt: input.now,
      })
      .where(and(
        eq(externalHumanIdentityLinks.id, same.id),
        eq(externalHumanIdentityLinks.state, "active"),
        eq(externalHumanIdentityLinks.linkEpoch, same.linkEpoch),
      ))
      .returning({ id: externalHumanIdentityLinks.id });
    if (!updated) {
      throw new ExternalAppControlPlaneError(
        "External human identity link lost its state fence",
        "external_app_persist_failed",
      );
    }
    return { id: updated.id, linkEpoch };
  }

  const [created] = await tx
    .insert(externalHumanIdentityLinks)
    .values({
      serverId: input.serverId,
      installId: input.installId,
      userId: input.userId,
      provider: "slack",
      providerAuthorityId: input.providerAuthorityId,
      providerUserId: input.providerUserId,
      state: "active",
      linkEpoch,
      observedConnectionEpoch: input.observedConnectionEpoch,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning({ id: externalHumanIdentityLinks.id });
  if (!created) {
    throw new ExternalAppControlPlaneError(
      "External human identity link could not be persisted",
      "external_app_persist_failed",
    );
  }
  return { id: created.id, linkEpoch };
}

export async function completeExternalOAuthAttempt(input: {
  attemptId: string;
  providerAppId: string;
  providerTeamId: string;
  providerEnterpriseId?: string | null;
  providerUserId: string;
  providerInstallerIsWorkspaceAdmin: boolean;
  botUserId: string;
  providerBotId?: string | null;
  workspaceName?: string | null;
  installedScopes: string[];
  sealedCredential: SealedExternalCredential;
}): Promise<{
  installId: string;
  connectionEpoch: number;
  credentialRevision: number;
  identityLinkEpoch: number;
}> {
  const now = currentDate();
  const providerTeamId = input.providerTeamId.trim();
  const providerUserId = input.providerUserId.trim();
  const botUserId = input.botUserId.trim();
  return getDb().transaction(async (tx) => {
    const [attempt] = await tx
      .select()
      .from(externalOAuthAttempts)
      .where(and(
        eq(externalOAuthAttempts.id, input.attemptId),
        eq(externalOAuthAttempts.status, "exchanging"),
        isNull(externalOAuthAttempts.consumedAt),
      ))
      .limit(1)
      .for("update");
    if (!attempt) {
      throw new ExternalAppControlPlaneError(
        "External OAuth attempt is not exchangeable",
        "external_app_invalid_state",
      );
    }

    const [server] = await tx
      .select({ id: servers.id })
      .from(servers)
      .where(and(
        eq(servers.id, attempt.serverId),
        ne(servers.kind, "joint_storage"),
        isNull(servers.deletedAt),
      ))
      .limit(1)
      .for("update");
    if (!server) {
      throw new ExternalAppControlPlaneError(
        "External app server is unavailable",
        "external_app_not_authorized",
      );
    }

    const { registration } = await loadCurrentGrant(tx as DbLike, {
      serverId: attempt.serverId,
      registrationId: attempt.registrationId,
      serverGrantId: attempt.serverGrantId,
      grantEpoch: attempt.grantEpoch,
      requestingUserId: attempt.requestingUserId,
      lock: true,
    });
    if (
      input.providerAppId !== registration.providerAppId
      || !providerTeamId
      || !providerUserId
      || !botUserId
      || input.providerInstallerIsWorkspaceAdmin !== true
      || providerUserId === botUserId
      || (
        input.providerEnterpriseId !== undefined
        && input.providerEnterpriseId !== null
      )
    ) {
      throw new ExternalAppControlPlaneError(
        "External provider identity does not match the registration",
        "external_app_not_authorized",
      );
    }
    const installedScopes = canonicalStrings(input.installedScopes);
    if (!sameStrings(installedScopes, attempt.requestedScopes)) {
      throw new ExternalAppControlPlaneError(
        "External provider scopes do not match the authorized request",
        "external_app_scope_mismatch",
      );
    }
    if (
      !input.sealedCredential.encryptedMaterial
      || !input.sealedCredential.envelopeKeyId
      || input.sealedCredential.aadVersion < 1
    ) {
      throw new ExternalAppControlPlaneError(
        "External credential is not sealed",
        "external_app_invalid_state",
      );
    }

    const [existing] = await tx
      .select()
      .from(externalAppInstalls)
      .where(and(
        eq(externalAppInstalls.registrationId, registration.id),
        eq(externalAppInstalls.authorityType, "team"),
        eq(externalAppInstalls.providerAuthorityId, providerTeamId),
      ))
      .limit(1)
      .for("update");
    const [existingCredential] = existing
      ? await tx.select().from(externalAppCredentials).where(and(
          eq(externalAppCredentials.installId, existing.id),
          eq(externalAppCredentials.credentialRevision, existing.credentialRevision),
        )).for("update").limit(1)
      : [];
    const existingCredentialUsable = Boolean(
      existing
      && existing.state === "active"
      && existingCredential?.state === "active"
      && (existingCredential.expiresAt === null || existingCredential.expiresAt > now),
    );
    const sharedInstallIdentityMatches = Boolean(
      existing
      && existing.providerAppId === input.providerAppId
      && existing.providerTeamId === providerTeamId
      && existing.providerAuthorityId === providerTeamId
      && existing.botUserId === botUserId
      && (existing.providerBotId === null || existing.providerBotId === (input.providerBotId ?? null))
      && sameStrings(existing.installedScopes, installedScopes),
    );
    if (
      existing
      && existing.serverId !== attempt.serverId
      && existingCredentialUsable
      && !sharedInstallIdentityMatches
    ) {
      throw new ExternalAppControlPlaneError(
        "External workspace identity conflicts with the shared installation",
        "external_app_install_conflict",
      );
    }
    const sharedGrantOnly = Boolean(
      existing
      && existing.serverId !== attempt.serverId
      && existingCredentialUsable
      && sharedInstallIdentityMatches,
    );
    const connectionEpoch = existing
      ? sharedGrantOnly ? existing.connectionEpoch : existing.connectionEpoch + 1
      : 1;
    const credentialRevision = existing
      ? sharedGrantOnly ? existing.credentialRevision : existing.credentialRevision + 1
      : 1;
    const [install] = sharedGrantOnly
      ? [existing!]
      : existing
      ? await tx
        .update(externalAppInstalls)
        .set({
          // The install row's server coordinates are the credential-AAD
          // steward, not the complete authorization set. The exact set lives
          // in external_app_install_server_grants below. A fresh OAuth
          // exchange reseals the one shared token for the authorizing server.
          serverId: attempt.serverId,
          serverGrantId: attempt.serverGrantId,
          grantEpoch: attempt.grantEpoch,
          state: "active",
          stateReason: null,
          connectionEpoch,
          scopeRevision: existing.scopeRevision + 1,
          credentialRevision,
          installedScopes,
          providerAppId: input.providerAppId,
          providerTeamId,
          providerEnterpriseId: null,
          providerAuthorityId: providerTeamId,
          botUserId,
          providerBotId: input.providerBotId ?? null,
          workspaceName: input.workspaceName ?? null,
          lastVerifiedAt: now,
          disconnectedAt: null,
          updatedAt: now,
        })
        .where(eq(externalAppInstalls.id, existing.id))
        .returning()
      : await tx
        .insert(externalAppInstalls)
        .values({
          serverId: attempt.serverId,
          registrationId: registration.id,
          serverGrantId: attempt.serverGrantId,
          grantEpoch: attempt.grantEpoch,
          state: "active",
          connectionEpoch,
          scopeRevision: 1,
          credentialRevision,
          installedScopes,
          providerAppId: input.providerAppId,
          providerTeamId,
          providerEnterpriseId: null,
          authorityType: "team",
          providerAuthorityId: providerTeamId,
          botUserId,
          providerBotId: input.providerBotId ?? null,
          workspaceName: input.workspaceName ?? null,
          lastVerifiedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
    if (!install) {
      throw new ExternalAppControlPlaneError(
        "External app install could not be persisted",
        "external_app_persist_failed",
      );
    }

    if (existing && !sharedGrantOnly) {
      const currentBindings = await tx.select().from(externalChannelBindings).where(and(
        eq(externalChannelBindings.installId, existing.id),
        eq(externalChannelBindings.connectionEpoch, existing.connectionEpoch),
        or(
          eq(externalChannelBindings.state, "active"),
          eq(externalChannelBindings.state, "paused"),
          eq(externalChannelBindings.state, "quarantined"),
        ),
      )).for("update");
      for (const binding of currentBindings) {
        const [frozen] = await tx.update(externalChannelBindings).set({
          state: "paused",
          stateReason: "provider_reauthorized_review_required",
          connectionEpoch,
          bindingEpoch: binding.bindingEpoch + 1,
          updatedAt: now,
        }).where(and(
          eq(externalChannelBindings.id, binding.id),
          eq(externalChannelBindings.state, binding.state),
          eq(externalChannelBindings.connectionEpoch, binding.connectionEpoch),
          eq(externalChannelBindings.bindingEpoch, binding.bindingEpoch),
        )).returning({ id: externalChannelBindings.id });
        if (!frozen) {
          throw new ExternalAppControlPlaneError(
            "External workspace bindings changed during reauthorization",
            "external_app_install_conflict",
          );
        }
      }
    }

    await tx
      .insert(externalAppInstallServerGrants)
      .values({
        installId: install.id,
        serverId: attempt.serverId,
        registrationId: registration.id,
        serverGrantId: attempt.serverGrantId,
        grantEpoch: attempt.grantEpoch,
        state: "active",
        authorizedByType: "human",
        authorizedById: attempt.requestingUserId,
        revokedAt: null,
        revokeReason: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          externalAppInstallServerGrants.installId,
          externalAppInstallServerGrants.serverId,
        ],
        set: {
          registrationId: registration.id,
          serverGrantId: attempt.serverGrantId,
          grantEpoch: attempt.grantEpoch,
          state: "active",
          authorizedByType: "human",
          authorizedById: attempt.requestingUserId,
          revokedAt: null,
          revokeReason: null,
          updatedAt: now,
        },
      });

    if (!sharedGrantOnly) {
      await tx
        .insert(externalAppCredentials)
        .values({
          installId: install.id,
          state: "active",
          encryptedMaterial: input.sealedCredential.encryptedMaterial,
          envelopeKeyId: input.sealedCredential.envelopeKeyId,
          aadVersion: input.sealedCredential.aadVersion,
          credentialRevision,
          expiresAt: input.sealedCredential.expiresAt ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: externalAppCredentials.installId,
          set: {
            state: "active",
            encryptedMaterial: input.sealedCredential.encryptedMaterial,
            envelopeKeyId: input.sealedCredential.envelopeKeyId,
            aadVersion: input.sealedCredential.aadVersion,
            credentialRevision,
            expiresAt: input.sealedCredential.expiresAt ?? null,
            leaseOwner: null,
            leaseExpiresAt: null,
            revokedAt: null,
            updatedAt: now,
          },
        });
    }

    const identity = await persistExternalHumanIdentityLink(tx as DbLike, {
      serverId: attempt.serverId,
      installId: install.id,
      userId: attempt.requestingUserId,
      providerAuthorityId: providerTeamId,
      providerUserId,
      observedConnectionEpoch: connectionEpoch,
      now,
    });

    const [consumed] = await tx
      .update(externalOAuthAttempts)
      .set({ status: "consumed", consumedAt: now, updatedAt: now })
      .where(and(
        eq(externalOAuthAttempts.id, attempt.id),
        eq(externalOAuthAttempts.status, "exchanging"),
      ))
      .returning({ id: externalOAuthAttempts.id });
    if (!consumed) {
      throw new ExternalAppControlPlaneError(
        "External OAuth completion lost its state fence",
        "external_app_persist_failed",
      );
    }

    return {
      installId: install.id,
      connectionEpoch,
      credentialRevision,
      identityLinkEpoch: identity.linkEpoch,
    };
  });
}

export async function revokeExternalHumanIdentityLink(input: {
  serverId: string;
  installId: string;
  userId: string;
  expectedLinkEpoch: number;
  reason: string;
}): Promise<{ revoked: boolean; linkEpoch: number | null }> {
  const reason = input.reason.trim();
  if (
    !input.serverId
    || !input.installId
    || !input.userId
    || !Number.isInteger(input.expectedLinkEpoch)
    || input.expectedLinkEpoch < 1
    || !reason
  ) {
    throw new ExternalAppControlPlaneError(
      "External human identity revocation is invalid",
      "external_app_invalid_state",
    );
  }
  const now = currentDate();
  return getDb().transaction(async (tx) => {
    const [link] = await tx
      .select({
        id: externalHumanIdentityLinks.id,
        linkEpoch: externalHumanIdentityLinks.linkEpoch,
      })
      .from(externalHumanIdentityLinks)
      .innerJoin(
        externalAppInstalls,
        eq(externalAppInstalls.id, externalHumanIdentityLinks.installId),
      )
      .innerJoin(
        externalAppInstallServerGrants,
        and(
          eq(externalAppInstallServerGrants.installId, externalHumanIdentityLinks.installId),
          eq(externalAppInstallServerGrants.serverId, externalHumanIdentityLinks.serverId),
        ),
      )
      .where(and(
        eq(externalHumanIdentityLinks.serverId, input.serverId),
        eq(externalHumanIdentityLinks.installId, input.installId),
        eq(externalHumanIdentityLinks.userId, input.userId),
        eq(externalHumanIdentityLinks.state, "active"),
        eq(externalHumanIdentityLinks.linkEpoch, input.expectedLinkEpoch),
        eq(externalAppInstallServerGrants.serverId, input.serverId),
        eq(externalAppInstallServerGrants.state, "active"),
      ))
      .limit(1)
      .for("update");
    if (!link) return { revoked: false, linkEpoch: null };
    const [revoked] = await tx
      .update(externalHumanIdentityLinks)
      .set({
        state: "revoked",
        revokedAt: now,
        revokeReason: reason,
        updatedAt: now,
      })
      .where(and(
        eq(externalHumanIdentityLinks.id, link.id),
        eq(externalHumanIdentityLinks.state, "active"),
        eq(externalHumanIdentityLinks.linkEpoch, link.linkEpoch),
      ))
      .returning({ linkEpoch: externalHumanIdentityLinks.linkEpoch });
    return revoked
      ? { revoked: true, linkEpoch: revoked.linkEpoch }
      : { revoked: false, linkEpoch: null };
  });
}

export async function markExternalOAuthExchangeUnknown(
  attemptId: string,
): Promise<boolean> {
  const now = currentDate();
  const [updated] = await getDb()
    .update(externalOAuthAttempts)
    .set({ status: "exchange_unknown", updatedAt: now })
    .where(and(
      eq(externalOAuthAttempts.id, attemptId),
      eq(externalOAuthAttempts.status, "exchanging"),
      isNull(externalOAuthAttempts.consumedAt),
    ))
    .returning({ id: externalOAuthAttempts.id });
  return Boolean(updated);
}

export type ExternalBindingAuthorityReason =
  | "binding_missing"
  | "binding_inactive"
  | "registration_inactive"
  | "grant_inactive"
  | "install_presence_missing"
  | "install_inactive"
  | "credential_unavailable"
  | "credential_stale"
  | "privacy_stale"
  | "epoch_mismatch"
  | "channel_unavailable"
  | "install_grant_unavailable"
  | "secret_reference_unavailable"
  | "install_grant_stale"
  | "install_grant_mismatch"
  | "audience_unavailable"
  | "audience_stale"
  | "audience_mismatch";

export type ExternalBindingAuthorityDecision =
  | {
    active: false;
    reason: ExternalBindingAuthorityReason;
  }
  | {
    active: true;
    fact: {
      provider: "slack";
      environment: "test" | "production";
      registrationId: string;
      serverId: string;
      serverGrantId: string;
      grantEpoch: number;
      installId: string;
      providerAppId: string;
      connectionEpoch: number;
      scopeRevision: number;
      credentialRevision: number;
      bindingId: string;
      bindingEpoch: number;
      privacyClass: "public" | "private";
      channelId: string;
      providerAuthorityId: string;
      providerConversationId: string;
      installGrantReceiptRevision: number;
      audienceRevision: number | null;
    };
  };

export async function resolveExternalBindingAuthority(input: {
  serverId: string;
  bindingId: string;
  expectedConnectionEpoch: number;
  expectedBindingEpoch: number;
  now?: Date;
}, db?: DbLike): Promise<ExternalBindingAuthorityDecision> {
  const now = input.now ?? currentDate();
  const resolve = async (tx: DbLike): Promise<ExternalBindingAuthorityDecision> => {
    const [binding] = await tx
      .select()
      .from(externalChannelBindings)
      .where(and(
        eq(externalChannelBindings.id, input.bindingId),
        eq(externalChannelBindings.serverId, input.serverId),
      ))
      .limit(1);
    if (!binding) return { active: false, reason: "binding_missing" };
    if (binding.state !== "active") return { active: false, reason: "binding_inactive" };
    if (!binding.privacyFreshUntil || binding.privacyFreshUntil <= now) {
      return { active: false, reason: "privacy_stale" };
    }

    const [registration] = await tx
      .select()
      .from(externalAppRegistrations)
      .where(eq(externalAppRegistrations.id, binding.registrationId))
      .limit(1);
    if (!registration || registration.state !== "active") {
      return { active: false, reason: "registration_inactive" };
    }

    const [install] = await tx
      .select()
      .from(externalAppInstalls)
      .where(eq(externalAppInstalls.id, binding.installId))
      .limit(1);
    if (!install || install.state !== "active") {
      return { active: false, reason: "install_inactive" };
    }
    const serverAuthority = await resolveExternalInstallServerGrantAuthority(tx, {
      installId: install.id,
      serverId: input.serverId,
      registrationId: registration.id,
    });
    if (!serverAuthority.current) {
      return {
        active: false,
        reason: serverAuthority.reason === "epoch_mismatch" ? "epoch_mismatch" : "grant_inactive",
      };
    }
    const { association: installServerGrant, grant: currentGrant } = serverAuthority;
    if (
      install.registrationId !== registration.id
      || install.providerAppId !== registration.providerAppId
      || currentGrant.grantedManifestVersion !== registration.capabilityManifestVersion
      || currentGrant.grantedManifestHash !== registration.capabilityManifestHash
      || !sameStrings(
        currentGrant.grantedCapabilities,
        registration.requiredCapabilities,
      )
    ) {
      return { active: false, reason: "grant_inactive" };
    }

    const [presence] = await tx
      .select({ id: oauthClientInstalls.id })
      .from(oauthClientInstalls)
      .where(and(
        eq(oauthClientInstalls.serverId, input.serverId),
        eq(oauthClientInstalls.clientId, registration.oauthClientId),
      ))
      .limit(1);
    if (!presence) return { active: false, reason: "install_presence_missing" };

    if (
      binding.grantEpoch !== currentGrant.grantEpoch
      || installServerGrant.grantEpoch !== currentGrant.grantEpoch
      || binding.connectionEpoch !== install.connectionEpoch
      || install.connectionEpoch !== input.expectedConnectionEpoch
      || binding.bindingEpoch !== input.expectedBindingEpoch
    ) {
      return { active: false, reason: "epoch_mismatch" };
    }

    const [credential] = await tx
      .select({
        state: externalAppCredentials.state,
        credentialRevision: externalAppCredentials.credentialRevision,
        expiresAt: externalAppCredentials.expiresAt,
      })
      .from(externalAppCredentials)
      .where(eq(externalAppCredentials.installId, install.id))
      .limit(1);
    if (!credential || credential.state !== "active") {
      return { active: false, reason: "credential_unavailable" };
    }
    if (
      credential.credentialRevision !== install.credentialRevision
      || credential.expiresAt && credential.expiresAt <= now
    ) {
      return { active: false, reason: "credential_stale" };
    }

    const [channel] = await tx
      .select({
        serverId: channels.serverId,
        type: channels.type,
        archivedAt: channels.archivedAt,
        deletedAt: channels.deletedAt,
      })
      .from(channels)
      .where(eq(channels.id, binding.channelId))
      .limit(1);
    const conversationTarget = channel
      ? await resolveExternalConversationTarget({
        executor: tx,
        authorityChannelId: binding.channelId,
      })
      : null;
    if (
      !channel
      || channel.serverId !== input.serverId
      || channel.deletedAt
      || channel.archivedAt
      || !conversationTarget
      || conversationTarget.serverId !== input.serverId
      || conversationTarget.bindingChannelId !== binding.channelId
      || conversationTarget.level !== "top_level"
      || (binding.privacyClass === "public" && !(
        conversationTarget.kind === "ordinary" && channel.type === "channel"
        || conversationTarget.kind === "joint" && conversationTarget.role === "host"
      ))
      || (binding.privacyClass === "private" && !(
        conversationTarget.kind === "ordinary" && channel.type === "private"
      ))
    ) {
      return { active: false, reason: "channel_unavailable" };
    }

    const [installGrant] = await tx
      .select()
      .from(externalAppInstallGrantReceipts)
      .where(and(
        eq(externalAppInstallGrantReceipts.registrationId, registration.id),
        eq(externalAppInstallGrantReceipts.installId, install.id),
      ))
      .orderBy(desc(externalAppInstallGrantReceipts.receiptRevision))
      .limit(1);
    if (!installGrant) return { active: false, reason: "install_grant_unavailable" };
    const secretRefs = await tx
      .select({
        purpose: externalAppRegistrationSecrets.purpose,
        secretRevision: externalAppRegistrationSecrets.secretRevision,
        revokedAt: externalAppRegistrationSecrets.revokedAt,
      })
      .from(externalAppRegistrationSecrets)
      .where(eq(externalAppRegistrationSecrets.registrationId, registration.id));
    const signingSecret = secretRefs.find((secret) =>
      secret.purpose === "signing_secret" && secret.revokedAt === null
    );
    if (
      !signingSecret
    ) {
      return { active: false, reason: "secret_reference_unavailable" };
    }
    if (installGrant.status !== "valid") {
      return { active: false, reason: "install_grant_mismatch" };
    }
    if (installGrant.expiresAt <= now) {
      return { active: false, reason: "install_grant_stale" };
    }
    if (
      installGrant.providerAppId !== registration.providerAppId
      || installGrant.installId !== install.id
      || installGrant.connectionEpoch !== install.connectionEpoch
      || installGrant.scopeRevision !== install.scopeRevision
      || installGrant.credentialRevision !== install.credentialRevision
      || installGrant.providerAuthorityId !== install.providerAuthorityId
      || installGrant.botUserId !== install.botUserId
      || (install.providerBotId !== null && installGrant.providerBotId !== install.providerBotId)
      || !sameStrings(install.installedScopes, installGrant.grantedScopes)
      || installGrant.grantHash !== slackBridgeInstallGrantHash(installGrant)
    ) {
      return { active: false, reason: "install_grant_mismatch" };
    }

    let audienceRevision: number | null = null;
    if (binding.privacyClass === "private") {
      if (!binding.audienceRevision || !binding.audienceFreshUntil) {
        return { active: false, reason: "audience_unavailable" };
      }
      if (binding.audienceFreshUntil <= now) {
        return { active: false, reason: "audience_stale" };
      }
      const [audience] = await tx
        .select()
        .from(externalBindingAudienceSnapshots)
        .where(and(
          eq(externalBindingAudienceSnapshots.bindingId, binding.id),
          eq(externalBindingAudienceSnapshots.bindingEpoch, binding.bindingEpoch),
          eq(externalBindingAudienceSnapshots.audienceRevision, binding.audienceRevision),
        ))
        .limit(1);
      if (!audience) return { active: false, reason: "audience_unavailable" };
      if (audience.status === "unavailable") {
        return { active: false, reason: "audience_unavailable" };
      }
      if (audience.status === "mismatch") {
        return { active: false, reason: "audience_mismatch" };
      }
      if (audience.expiresAt <= now) return { active: false, reason: "audience_stale" };
      audienceRevision = audience.audienceRevision;
    }

    return {
      active: true,
      fact: {
        provider: registration.provider,
        environment: registration.environment,
        registrationId: registration.id,
        serverId: input.serverId,
        serverGrantId: currentGrant.id,
        grantEpoch: currentGrant.grantEpoch,
        installId: install.id,
        providerAppId: install.providerAppId,
        connectionEpoch: install.connectionEpoch,
        scopeRevision: install.scopeRevision,
        credentialRevision: install.credentialRevision,
        bindingId: binding.id,
        bindingEpoch: binding.bindingEpoch,
        privacyClass: binding.privacyClass,
        channelId: binding.channelId,
        providerAuthorityId: install.providerAuthorityId,
        providerConversationId: binding.providerConversationId,
        installGrantReceiptRevision: installGrant.receiptRevision,
        audienceRevision,
      },
    };
  };
  if (db) return resolve(db);
  return getDb().transaction(async (tx) => resolve(tx as DbLike), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

export async function getExternalAppRegistrationMetadata(
  registrationId: string,
): Promise<{
  id: string;
  provider: "slack";
  environment: "test" | "production";
  state: "active" | "disabled";
  capabilityManifestVersion: number;
  capabilityManifestHash: string;
  latestInstallGrantReceipt: null | {
    revision: number;
    status: "valid" | "mismatch" | "unreadable";
    observedAt: Date;
    expiresAt: Date;
  };
} | null> {
  return getDb().transaction(async (tx) => {
    const [registration] = await tx
      .select({
        id: externalAppRegistrations.id,
        provider: externalAppRegistrations.provider,
        environment: externalAppRegistrations.environment,
        state: externalAppRegistrations.state,
        capabilityManifestVersion: externalAppRegistrations.capabilityManifestVersion,
        capabilityManifestHash: externalAppRegistrations.capabilityManifestHash,
      })
      .from(externalAppRegistrations)
      .where(eq(externalAppRegistrations.id, registrationId))
      .limit(1);
    if (!registration) return null;

    const [receipt] = await tx
      .select({
        revision: externalAppInstallGrantReceipts.receiptRevision,
        status: externalAppInstallGrantReceipts.status,
        observedAt: externalAppInstallGrantReceipts.observedAt,
        expiresAt: externalAppInstallGrantReceipts.expiresAt,
      })
      .from(externalAppInstallGrantReceipts)
      .where(eq(externalAppInstallGrantReceipts.registrationId, registration.id))
      .orderBy(desc(externalAppInstallGrantReceipts.createdAt))
      .limit(1);
    return {
      ...registration,
      latestInstallGrantReceipt: receipt ?? null,
    };
  }, {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}
