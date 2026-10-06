import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import {
  currentDate,
  currentTimeMs,
  type ProviderConnectionLaunchProjection,
  PROVIDER_PROBE_BUDGET_MS,
  PROVIDER_PROBE_CAPABILITY,
  PROVIDER_PROBE_MATERIALIZE_LEASE_MS,
  PROVIDER_PROBE_RATE_WINDOW_MS,
  PROVIDER_PROBE_REPLY_MAX_BYTES,
  boundProviderProbeReply,
  isProviderProbeCategory,
  isProviderProbeDaemonCategory,
  isProviderProbeKind,
  isProviderProbeOutcome,
  isProviderProbeRuntime,
  asProviderProbeId,
  mintProviderProbeId,
  providerProbeAuthorityIdentity,
  providerProbeIntentDigest,
  providerProbeMaterializationDigest,
  providerProbeRequestDigest,
  providerProbeResultDigest,
  sha256Hex,
  utf8ByteLength,
  type MachineProviderProbeResult,
  type ProviderProbeCategory,
  type ProviderProbeCreatedView,
  type ProviderProbeId,
  type ProviderProbeReceiptList,
  type ProviderProbeReceiptSummary,
  type ProviderProbeReceiptView,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseTransaction } from "../db/index";
import {
  machines,
  providerConnections,
  providerConnectionCredentials,
  providerProbeIntents,
  providerProbeReceipts,
} from "../db/schema";
import { isProviderConnectionsEnabled, isProviderProbesEnabled } from "./providerConnectionFeature";
import { recordIntegrationAuditEvent } from "./integrationAuditService";
import { resolveProviderConnectionProbeMaterialization } from "./providerConnectionService";

export type ProviderProbeErrorCode =
  | "probe_disabled"
  | "probe_not_found"
  | "probe_invalid"
  | "probe_expired"
  | "probe_request_conflict"
  | "probe_receipt_conflict"
  | "probe_claim_conflict"
  | "probe_rate_limited"
  | "probe_stale_authority"
  | "probe_key_missing"
  | "probe_unavailable";

export class ProviderProbeError extends Error {
  constructor(
    message: string,
    readonly code: ProviderProbeErrorCode,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ProviderProbeError";
  }
}

/** Server-decided closure reasons; also the receipt category for those closures. */
export type ProviderProbeCloseReason = Extract<ProviderProbeCategory,
  | "carrier_offline"
  | "carrier_timeout"
  | "unsupported_carrier"
  | "provider_timeout"
  | "stale_authority"
  | "intent_expired"
  | "invalid_carrier_result">;

/** Cross-replica carrier fact frozen onto the intent at dispatch (F1/F7). */
export interface ProbeCarrierFact {
  capabilities: string[];
  connectionEpochId: string;
  replicaGeneration: string;
  daemonVersion: string | null;
  computerVersion: string | null;
  runtimes: string[];
  runtimeVersions: Record<string, string>;
}

export type ProbeCarrierOutcome =
  | { kind: "result"; result: MachineProviderProbeResult }
  | { kind: "send_failed" }
  | { kind: "timeout" };

let carrierOverride: ProbeCarrier | null = null;

/**
 * Test seam: replace the machine transport so lost-response, no-capability and
 * late-result paths are exercisable without a daemon. Production never sets it.
 */
export function __setProviderProbeCarrierForTests(carrier: ProbeCarrier | null): void {
  carrierOverride = carrier;
}

export function resolveProviderProbeCarrier(carrier: ProbeCarrier): ProbeCarrier {
  return carrierOverride ?? carrier;
}

export interface ProbeCarrier {
  /** Cross-replica readable carrier fact; null when the machine is unknown/stale. */
  readFact(machineId: string): Promise<ProbeCarrierFact | null>;
  dispatch(
    machineId: string,
    command: { requestId: string; probeId: ProviderProbeId; runtime: string; model: string },
  ): Promise<ProbeCarrierOutcome>;
}

type IntentRow = typeof providerProbeIntents.$inferSelect;
type ReceiptRow = typeof providerProbeReceipts.$inferSelect;

const RESULT_DIGEST_HEX = /^[a-f0-9]{64}$/u;

/** Audit never carries the raw gateway model; preset ids are canonical already. */
async function modelAuditValue(model: string): Promise<string> {
  return sha256Hex(model);
}

function projectView(intent: IntentRow, receipt: ReceiptRow | null): ProviderProbeReceiptView {
  // DB check constraints make these projections total; a violation means the
  // schema guard was removed, which must surface rather than silently widen.
  if (!isProviderProbeKind(intent.probeKind)) {
    throw new ProviderProbeError("Stored probe kind is outside the contract", "probe_unavailable");
  }
  const outcome = receipt === null
    ? null
    : isProviderProbeOutcome(receipt.outcome)
      ? receipt.outcome
      : (() => { throw new ProviderProbeError("Stored probe outcome is outside the contract", "probe_unavailable"); })();
  const category = receipt?.category == null
    ? null
    : isProviderProbeCategory(receipt.category)
      ? receipt.category
      : (() => { throw new ProviderProbeError("Stored probe category is outside the contract", "probe_unavailable"); })();
  return {
    probeId: asProviderProbeId(intent.id),
    probeRequestId: intent.probeRequestId,
    connectionId: intent.connectionId,
    computerId: intent.computerId,
    runtime: intent.runtime,
    model: intent.model,
    probeKind: intent.probeKind,
    configVersion: intent.configVersion,
    credentialVersion: intent.credentialVersion,
    outcome,
    category,
    latencyMs: receipt?.latencyMs ?? null,
    responseSha256: receipt?.responseSha256 ?? null,
    responseBytes: receipt?.responseBytes ?? null,
    verifiedAt: receipt?.verifiedAt.toISOString() ?? null,
    closedAt: intent.closedAt?.toISOString() ?? null,
    createdAt: intent.createdAt.toISOString(),
    expiresAt: intent.expiresAt.toISOString(),
  };
}

async function loadReceipt(probeId: string): Promise<ReceiptRow | null> {
  const [receipt] = await getDb().select().from(providerProbeReceipts)
    .where(eq(providerProbeReceipts.probeId, probeId)).limit(1);
  return receipt ?? null;
}

/**
 * Single terminal-closure path: close the intent and insert the receipt once,
 * always auditing probe_receipt so every closed state is observable (F7).
 */
async function closeProbeTerminal(
  tx: DatabaseTransaction,
  intent: IntentRow,
  reason: ProviderProbeCloseReason,
  extra?: {
    latencyMs?: number | null;
    responseSha256?: string | null;
    responseBytes?: number | null;
    resultDigest?: string;
    authorityIdentity?: string | null;
    daemonVersion?: string | null;
    computerVersion?: string | null;
    runtimeVersion?: string | null;
    dispatchEpochId?: string | null;
    dispatchGeneration?: string | null;
  },
): Promise<void> {
  const now = currentDate();
  if (intent.closedAt === null) {
    await tx.update(providerProbeIntents).set({ closeReason: reason, closedAt: now })
      .where(and(eq(providerProbeIntents.id, intent.id), isNull(providerProbeIntents.closedAt)));
  }
  const [existing] = await tx.select().from(providerProbeReceipts)
    .where(eq(providerProbeReceipts.probeId, intent.id)).limit(1);
  if (existing) return;
  await tx.insert(providerProbeReceipts).values({
    probeId: intent.id,
    serverId: intent.serverId,
    outcome: "failure",
    category: reason,
    latencyMs: extra?.latencyMs ?? null,
    responseSha256: extra?.responseSha256 ?? null,
    responseBytes: extra?.responseBytes ?? null,
    resultDigest: extra?.resultDigest ?? await providerProbeResultDigest({
      outcome: "failure",
      category: reason,
      responseSha256: null,
      responseBytes: null,
      authorityIdentity: extra?.authorityIdentity ?? "none",
    }),
    intentDigest: intent.intentDigest,
    materializationDigest: intent.materializationDigest,
    authorityIdentity: extra?.authorityIdentity ?? null,
    daemonVersion: extra?.daemonVersion ?? null,
    computerVersion: extra?.computerVersion ?? null,
    runtimeVersion: extra?.runtimeVersion ?? null,
    dispatchEpochId: extra?.dispatchEpochId ?? intent.dispatchEpochId,
    dispatchGeneration: extra?.dispatchGeneration ?? intent.dispatchGeneration,
    verifiedAt: now,
  });
  await recordIntegrationAuditEvent({
    serverId: intent.serverId,
    eventType: "provider_connection.probe_receipt",
    outcome: "failure",
    source: "system",
    actor: { type: "system" },
    target: { type: "provider_connection", id: intent.connectionId },
    metadata: {
      probeId: intent.id,
      computerId: intent.computerId,
      runtime: intent.runtime,
      modelDigest: await modelAuditValue(intent.model),
      configVersion: intent.configVersion,
      credentialVersion: intent.credentialVersion,
      category: reason,
      latencyMs: extra?.latencyMs ?? null,
    },
  }, tx);
}

async function closeProbeTerminalOutside(probeId: ProviderProbeId, reason: ProviderProbeCloseReason): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [intent] = await tx.select().from(providerProbeIntents)
      .where(eq(providerProbeIntents.id, probeId)).limit(1).for("update");
    if (!intent) return;
    await closeProbeTerminal(tx, intent, reason);
  });
}

export async function createProviderProbe(input: {
  serverId: string;
  userId: string;
  connectionId: string;
  probeRequestId: string;
  requestDigest: string;
  computerId: string;
  runtime: string;
  model: string;
  probeKind: string;
  expiresAt: Date;
  carrier: ProbeCarrier;
}): Promise<ProviderProbeCreatedView> {
  const probeKind = input.probeKind;
  if (!isProviderProbeKind(probeKind)) {
    throw new ProviderProbeError("Probe kind is not supported", "probe_invalid");
  }
  // Wave 1 closes verification to the Built-in runtime; anything else is a
  // client error, never a relabelled Built-in receipt (F3).
  if (!isProviderProbeRuntime(input.runtime)) {
    throw new ProviderProbeError("Probe runtime is not supported in this wave", "probe_invalid");
  }
  if (input.model.length > 200) {
    throw new ProviderProbeError("Probe model is too long", "probe_invalid");
  }
  const expectedDigest = await providerProbeRequestDigest({
    connectionId: input.connectionId,
    computerId: input.computerId,
    runtime: input.runtime,
    model: input.model,
    probeKind,
  });
  if (expectedDigest !== input.requestDigest) {
    throw new ProviderProbeError("Request digest does not match the payload", "probe_invalid");
  }

  const created = await getDb().transaction(async (tx) => {
    const [connection] = await tx.select({
      id: providerConnections.id,
      configVersion: providerConnections.configVersion,
      credentialVersion: providerConnectionCredentials.credentialVersion,
    }).from(providerConnections).innerJoin(providerConnectionCredentials, and(
      eq(providerConnectionCredentials.serverId, providerConnections.serverId),
      eq(providerConnectionCredentials.connectionId, providerConnections.id),
    )).where(and(
      eq(providerConnections.serverId, input.serverId),
      eq(providerConnections.id, input.connectionId),
    )).limit(1);
    if (!connection) throw new ProviderProbeError("Provider connection not found", "probe_not_found");

    const [computer] = await tx.select({ id: machines.id, runtimes: machines.runtimes }).from(machines).where(and(
      eq(machines.serverId, input.serverId),
      eq(machines.id, input.computerId),
    )).limit(1);
    if (!computer) throw new ProviderProbeError("Computer not found", "probe_not_found");
    if (!Array.isArray(computer.runtimes) || !computer.runtimes.includes(input.runtime)) {
      throw new ProviderProbeError("Computer does not declare the probe runtime", "probe_invalid");
    }

    // Pair-level reservation: serializes concurrent creates for one
    // (connection, computer) so different idempotency keys cannot both pass
    // the pending/recent checks and dispatch twice (F4).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.serverId}:${input.connectionId}:${input.computerId}`}, 0))`);

    // Idempotency is re-checked INSIDE the pair lock so a concurrent same-key
    // create observes the winner's committed intent and replays it exactly,
    // instead of racing into a unique violation (F4/F5).
    const [existing] = await tx.select().from(providerProbeIntents).where(and(
      eq(providerProbeIntents.serverId, input.serverId),
      eq(providerProbeIntents.probeRequestId, input.probeRequestId),
    )).limit(1);
    if (existing) {
      if (existing.requestDigest !== input.requestDigest || existing.connectionId !== input.connectionId) {
        throw new ProviderProbeError("Idempotency key reused with a different payload", "probe_request_conflict");
      }
      return { intent: existing, replayed: true };
    }

    const now = currentDate();
    const [pending] = await tx.select({ id: providerProbeIntents.id, expiresAt: providerProbeIntents.expiresAt })
      .from(providerProbeIntents).where(and(
        eq(providerProbeIntents.serverId, input.serverId),
        eq(providerProbeIntents.connectionId, input.connectionId),
        eq(providerProbeIntents.computerId, input.computerId),
        isNull(providerProbeIntents.closedAt),
        gt(providerProbeIntents.expiresAt, now),
      )).limit(1);
    if (pending) {
      const retryAfter = Math.max(1, Math.ceil((pending.expiresAt.getTime() - now.getTime()) / 1000));
      throw new ProviderProbeError("A probe is already pending for this connection and Computer", "probe_rate_limited", retryAfter);
    }
    const windowStart = new Date(now.getTime() - PROVIDER_PROBE_RATE_WINDOW_MS);
    const [recent] = await tx.select({ dispatchedAt: providerProbeIntents.dispatchedAt })
      .from(providerProbeIntents).where(and(
        eq(providerProbeIntents.serverId, input.serverId),
        eq(providerProbeIntents.connectionId, input.connectionId),
        eq(providerProbeIntents.computerId, input.computerId),
        gt(providerProbeIntents.dispatchedAt, windowStart),
      )).orderBy(sql`${providerProbeIntents.dispatchedAt} desc`).limit(1);
    if (recent?.dispatchedAt) {
      const retryAfter = Math.max(1, Math.ceil(
        (recent.dispatchedAt.getTime() + PROVIDER_PROBE_RATE_WINDOW_MS - now.getTime()) / 1000,
      ));
      throw new ProviderProbeError("Probe rate limit reached for this connection and Computer", "probe_rate_limited", retryAfter);
    }

    const probeId = mintProviderProbeId();
    const intentDigest = await providerProbeIntentDigest({
      serverId: input.serverId,
      connectionId: input.connectionId,
      configVersion: connection.configVersion,
      credentialVersion: connection.credentialVersion,
      computerId: input.computerId,
      runtime: input.runtime,
      model: input.model,
      probeKind,
      probeRequestId: input.probeRequestId,
      requestDigest: input.requestDigest,
    });
    const [intent] = await tx.insert(providerProbeIntents).values({
      id: probeId,
      serverId: input.serverId,
      connectionId: input.connectionId,
      configVersion: connection.configVersion,
      credentialVersion: connection.credentialVersion,
      computerId: input.computerId,
      runtime: input.runtime,
      model: input.model,
      probeKind,
      probeRequestId: input.probeRequestId,
      requestDigest: input.requestDigest,
      intentDigest,
      createdByUserId: input.userId,
      createdAt: now,
      expiresAt: input.expiresAt,
    }).returning();
    await recordIntegrationAuditEvent({
      serverId: input.serverId,
      eventType: "provider_connection.probe_issued",
      outcome: "success",
      source: "web",
      actor: { type: "human", id: input.userId },
      target: { type: "provider_connection", id: input.connectionId },
      metadata: {
        probeId,
        computerId: input.computerId,
        runtime: input.runtime,
        modelDigest: await modelAuditValue(input.model),
        credentialVersion: connection.credentialVersion,
        probeKind,
      },
    }, tx);
    return { intent, replayed: false };
  });

  if (created.replayed) {
    const receipt = await loadReceipt(created.intent.id);
    return { probe: projectView(created.intent, receipt), reply: null, replayed: true };
  }

  const intent = created.intent;
  if (intent.expiresAt.getTime() <= currentTimeMs()) {
    await closeProbeTerminalOutside(asProviderProbeId(intent.id), "intent_expired");
    const [closed] = await getDb().select().from(providerProbeIntents)
      .where(eq(providerProbeIntents.id, intent.id)).limit(1);
    const receipt = await loadReceipt(intent.id);
    return { probe: projectView(closed ?? intent, receipt), reply: null, replayed: false };
  }

  // Freeze the cross-replica carrier fact before the at-most-once dispatch so
  // materialize/result verification never depends on the serving replica (F1).
  const fact = await input.carrier.readFact(intent.computerId);
  const capability = fact?.capabilities.includes(PROVIDER_PROBE_CAPABILITY) === true;
  const runtimeVersion = fact?.runtimeVersions?.[intent.runtime] ?? "";
  if (!fact || !capability || runtimeVersion.length === 0) {
    await closeProbeTerminalOutside(asProviderProbeId(intent.id), "unsupported_carrier");
    const [closed] = await getDb().select().from(providerProbeIntents)
      .where(eq(providerProbeIntents.id, intent.id)).limit(1);
    const receipt = await loadReceipt(intent.id);
    return { probe: projectView(closed ?? intent, receipt), reply: null, replayed: false };
  }

  const requestId = randomUUID();
  const [marked] = await getDb().update(providerProbeIntents).set({
    dispatchedAt: currentDate(),
    dispatchRequestId: requestId,
    dispatchEpochId: fact.connectionEpochId,
    dispatchGeneration: fact.replicaGeneration,
    capabilityObserved: true,
    dispatchDaemonVersion: fact.daemonVersion,
    dispatchComputerVersion: fact.computerVersion,
    dispatchRuntimeVersion: runtimeVersion,
    dispatchRuntimes: fact.runtimes,
  })
    .where(and(eq(providerProbeIntents.id, intent.id), isNull(providerProbeIntents.dispatchedAt)))
    .returning();
  if (!marked) {
    const [fresh] = await getDb().select().from(providerProbeIntents)
      .where(eq(providerProbeIntents.id, intent.id)).limit(1);
    const receipt = await loadReceipt(intent.id);
    return { probe: projectView(fresh ?? intent, receipt), reply: null, replayed: true };
  }
  const dispatched = marked;

  let outcome: ProbeCarrierOutcome;
  try {
    outcome = await input.carrier.dispatch(intent.computerId, {
      requestId,
      probeId: asProviderProbeId(intent.id),
      runtime: intent.runtime,
      model: intent.model,
    });
  } catch {
    outcome = { kind: "send_failed" };
  }

  if (outcome.kind === "send_failed" || outcome.kind === "timeout") {
    const reason: ProviderProbeCloseReason = outcome.kind === "send_failed" ? "carrier_offline" : "carrier_timeout";
    await closeProbeTerminalOutside(asProviderProbeId(intent.id), reason);
    const [closed] = await getDb().select().from(providerProbeIntents)
      .where(eq(providerProbeIntents.id, intent.id)).limit(1);
    const receipt = await loadReceipt(intent.id);
    return { probe: projectView(closed ?? intent, receipt), reply: null, replayed: false };
  }

  const consumed = await consumeProviderProbeResult({ probeId: intent.id, message: outcome.result, carrier: input.carrier });
  void dispatched;
  return { probe: consumed.view, reply: consumed.reply, replayed: false };
}

/**
 * Consume one Computer probe result. Insert-once receipt; a replayed identical
 * result digest returns the existing terminal state, anything else is rejected
 * without touching it. Correlation, authority and wire shape are all verified
 * against stored state — the daemon's echoes are compared, never trusted.
 */
export async function consumeProviderProbeResult(input: {
  probeId: string;
  message: MachineProviderProbeResult;
  carrier?: ProbeCarrier;
}): Promise<{ view: ProviderProbeReceiptView; reply: string | null; replayed: boolean }> {
  const consumed = await getDb().transaction(async (tx) => {
    const [intent] = await tx.select().from(providerProbeIntents)
      .where(eq(providerProbeIntents.id, input.probeId)).limit(1).for("update");
    if (!intent) throw new ProviderProbeError("Provider probe not found", "probe_not_found");

    const message = input.message;
    // Correlation: a result for another probe or another dispatch must never
    // close this intent (F1).
    if (message.probeId !== intent.id || !intent.dispatchRequestId || message.requestId !== intent.dispatchRequestId) {
      throw new ProviderProbeError("Probe result does not match this dispatch", "probe_receipt_conflict");
    }

    const [existingReceipt] = await tx.select().from(providerProbeReceipts)
      .where(eq(providerProbeReceipts.probeId, intent.id)).limit(1);
    if (intent.closedAt !== null || existingReceipt) {
      if (existingReceipt && existingReceipt.resultDigest === message.resultDigest) {
        return { intent, receipt: existingReceipt, reply: null as string | null, replayed: true };
      }
      throw new ProviderProbeError("Probe already closed with a different result", "probe_receipt_conflict");
    }

    if (intent.expiresAt.getTime() <= currentDate().getTime()) {
      // A result that arrives after the intent expired can never count as
      // success; close intent_expired and hand back the failure view.
      await closeProbeTerminal(tx, intent, "intent_expired");
      const [closed] = await tx.select().from(providerProbeIntents)
        .where(eq(providerProbeIntents.id, intent.id)).limit(1);
      const [receipt] = await tx.select().from(providerProbeReceipts)
        .where(eq(providerProbeReceipts.probeId, intent.id)).limit(1);
      return { intent: closed ?? intent, receipt: receipt ?? null, reply: null as string | null, replayed: false };
    }
    if (!isProviderProbeOutcome(message.outcome)) {
      throw new ProviderProbeError("Probe result outcome is invalid", "probe_invalid");
    }
    if (!intent.claimMachineId || !intent.claimEpochId || !intent.claimGeneration) {
      // A result without a materialization claim never held authority.
      await closeProbeTerminal(tx, intent, "invalid_carrier_result");
      const [closed] = await tx.select().from(providerProbeIntents)
        .where(eq(providerProbeIntents.id, intent.id)).limit(1);
      const [receipt] = await tx.select().from(providerProbeReceipts)
        .where(eq(providerProbeReceipts.probeId, intent.id)).limit(1);
      return { intent: closed ?? intent, receipt: receipt ?? null, reply: null as string | null, replayed: false };
    }
    const authority = {
      connectionEpochId: intent.claimEpochId,
      replicaGeneration: intent.claimGeneration,
    };
    const authorityIdentity = await providerProbeAuthorityIdentity(authority);
    const echoMatches = message.authorityEcho?.connectionEpochId === authority.connectionEpochId
      && message.authorityEcho?.replicaGeneration === authority.replicaGeneration;
    // Result-time fresh fact: every axis must still agree with the frozen
    // dispatch fact, otherwise the round trip crossed a reconnect/upgrade and
    // can never count as success (F1/F7).
    const versionsMatch = message.daemonVersion === intent.dispatchDaemonVersion
      && message.computerVersion === intent.dispatchComputerVersion
      && message.runtimeVersion === intent.dispatchRuntimeVersion;
    let factFresh = true;
    if (input.carrier) {
      const current = await input.carrier.readFact(intent.computerId);
      factFresh = Boolean(current)
        && current!.capabilities.includes(PROVIDER_PROBE_CAPABILITY)
        && current!.connectionEpochId === intent.dispatchEpochId
        && current!.replicaGeneration === intent.dispatchGeneration
        && current!.daemonVersion === intent.dispatchDaemonVersion
        && current!.computerVersion === intent.dispatchComputerVersion
        && (current!.runtimeVersions?.[intent.runtime] ?? "") === intent.dispatchRuntimeVersion;
    }

    // Closed wire shape (F6): daemon-decided categories only, success requires a
    // non-blank bounded reply plus matching hash/bytes, failure carries nulls.
    const categoryOk = message.category === null || isProviderProbeDaemonCategory(message.category);
    const boundedReply = boundProviderProbeReply(message.reply);
    const responseBytes = typeof message.responseBytes === "number" && Number.isInteger(message.responseBytes)
      && message.responseBytes >= 0 && message.responseBytes <= PROVIDER_PROBE_REPLY_MAX_BYTES
      ? message.responseBytes
      : null;
    const hashOk = message.responseSha256 === null || RESULT_DIGEST_HEX.test(message.responseSha256);
    const latencyOk = message.latencyMs === null
      || (typeof message.latencyMs === "number" && message.latencyMs >= 0 && message.latencyMs <= PROVIDER_PROBE_BUDGET_MS + 5_000);
    let outcome = message.outcome;
    let category: ProviderProbeCategory | null = message.category;
    let shapeValid = categoryOk && hashOk && latencyOk;
    if (outcome === "success") {
      const replyValid = boundedReply !== null
        && message.responseSha256 === await sha256Hex(boundedReply)
        && responseBytes === utf8ByteLength(boundedReply);
      if (!echoMatches || !versionsMatch || !factFresh || !replyValid || message.category !== null) {
        outcome = "failure";
        category = factFresh ? "invalid_carrier_result" : "stale_authority";
        shapeValid = false;
      }
    } else {
      if (message.reply !== null || message.responseSha256 !== null || message.responseBytes !== null) {
        shapeValid = false;
      }
      if (category === null) category = "invalid_carrier_result";
    }
    if (!shapeValid && outcome === "success") {
      outcome = "failure";
      category = "invalid_carrier_result";
    }

    const resultDigest = await providerProbeResultDigest({
      outcome,
      category,
      responseSha256: outcome === "success" ? message.responseSha256 : null,
      responseBytes: outcome === "success" ? responseBytes : null,
      authorityIdentity,
    });
    if (!echoMatches || !versionsMatch || !factFresh || !shapeValid || resultDigest !== message.resultDigest) {
      // The daemon's chain link does not match what its own payload computes,
      // or the carrier fact moved under the round trip.
      await closeProbeTerminal(tx, intent, factFresh ? "invalid_carrier_result" : "stale_authority", { authorityIdentity });
      const [closed] = await tx.select().from(providerProbeIntents)
        .where(eq(providerProbeIntents.id, intent.id)).limit(1);
      const [receipt] = await tx.select().from(providerProbeReceipts)
        .where(eq(providerProbeReceipts.probeId, intent.id)).limit(1);
      return { intent: closed ?? intent, receipt: receipt ?? null, reply: null as string | null, replayed: false };
    }

    const now = currentDate();
    await tx.update(providerProbeIntents).set({ closeReason: "receipt", closedAt: now })
      .where(and(eq(providerProbeIntents.id, intent.id), isNull(providerProbeIntents.closedAt)));
    const [receipt] = await tx.insert(providerProbeReceipts).values({
      probeId: intent.id,
      serverId: intent.serverId,
      outcome,
      category,
      latencyMs: message.latencyMs ?? null,
      responseSha256: message.responseSha256 ?? null,
      responseBytes,
      resultDigest,
      intentDigest: intent.intentDigest,
      materializationDigest: intent.materializationDigest,
      authorityIdentity,
      // Coordinates derive from the frozen dispatch fact; daemon fields are
      // echo-compared above and never trusted as the stored truth.
      daemonVersion: intent.dispatchDaemonVersion,
      computerVersion: intent.dispatchComputerVersion,
      runtimeVersion: intent.dispatchRuntimeVersion,
      dispatchEpochId: intent.dispatchEpochId,
      dispatchGeneration: intent.dispatchGeneration,
      verifiedAt: now,
    }).returning();
    await recordIntegrationAuditEvent({
      serverId: intent.serverId,
      eventType: "provider_connection.probe_receipt",
      outcome,
      source: "system",
      actor: { type: "system" },
      target: { type: "provider_connection", id: intent.connectionId },
      metadata: {
        probeId: intent.id,
        computerId: intent.computerId,
        runtime: intent.runtime,
        modelDigest: await modelAuditValue(intent.model),
        configVersion: intent.configVersion,
        credentialVersion: intent.credentialVersion,
        category,
        latencyMs: message.latencyMs ?? null,
      },
    }, tx);
    const [closed] = await tx.select().from(providerProbeIntents)
      .where(eq(providerProbeIntents.id, intent.id)).limit(1);
    return {
      intent: closed ?? intent,
      receipt,
      reply: outcome === "success" ? boundedReply : null,
      replayed: false,
    };
  });
  return { view: projectView(consumed.intent, consumed.receipt), reply: consumed.reply, replayed: consumed.replayed };
}

/**
 * One-time materialization claim. The first valid claim wins atomically; the
 * same claimant may retry inside the lease (lost HTTP response), everyone else
 * is rejected. Expiry, base kill switches and carrier-authority drift all
 * close the intent before any credential leaves the Server (F2).
 */
export async function materializeProviderProbe(input: {
  serverId: string;
  probeId: ProviderProbeId;
  machineId: string;
  claimRequestId: string;
  fact: ProbeCarrierFact | null;
}): Promise<{
  envVars: Record<string, string>;
  providerConnection: ProviderConnectionLaunchProjection;
  authority: { connectionEpochId: string; replicaGeneration: string };
}> {
  if (!await isProviderConnectionsEnabled(input.serverId) || !await isProviderProbesEnabled(input.serverId)) {
    throw new ProviderProbeError("Provider probes are not enabled for this server", "probe_disabled");
  }
  if (input.claimRequestId.length === 0 || input.claimRequestId.length > 128) {
    throw new ProviderProbeError("Claim request id is invalid", "probe_invalid");
  }
  const [intentPre] = await getDb().select().from(providerProbeIntents)
    .where(and(
      eq(providerProbeIntents.id, input.probeId),
      eq(providerProbeIntents.serverId, input.serverId),
    )).limit(1);
  if (!intentPre) throw new ProviderProbeError("Provider probe not found", "probe_not_found");
  if (intentPre.closedAt !== null) {
    throw new ProviderProbeError("Provider probe is closed", "probe_claim_conflict");
  }
  // Expiry and closure are checked BEFORE any credential is decrypted, so an
  // expired intent can never hand out key material (F2).
  if (intentPre.expiresAt.getTime() <= currentTimeMs()) {
    await closeProbeTerminalOutside(asProviderProbeId(intentPre.id), "intent_expired");
    throw new ProviderProbeError("Provider probe expired before materialization", "probe_expired");
  }
  // Everything decidable from the intent and the presented fact is checked
  // BEFORE the credential boundary, so an invalid claimant never reaches the
  // decrypt path (boundary-before-secret). The transaction below re-checks the
  // same intent-derived facts to close the TOCTOU window.
  if (intentPre.computerId !== input.machineId) {
    throw new ProviderProbeError("Probe belongs to a different Computer", "probe_claim_conflict");
  }
  if (intentPre.dispatchRequestId !== input.claimRequestId) {
    throw new ProviderProbeError("Claim does not match the frozen dispatch request", "probe_claim_conflict");
  }
  if (
    !input.fact
    || !intentPre.dispatchEpochId
    || !intentPre.dispatchGeneration
    || input.fact.connectionEpochId !== intentPre.dispatchEpochId
    || input.fact.replicaGeneration !== intentPre.dispatchGeneration
    || !input.fact.capabilities.includes(PROVIDER_PROBE_CAPABILITY)
    || (input.fact.runtimeVersions?.[intentPre.runtime] ?? "") !== (intentPre.dispatchRuntimeVersion ?? "")
  ) {
    await closeProbeTerminalOutside(asProviderProbeId(intentPre.id), "stale_authority");
    throw new ProviderProbeError("Provider connection authority changed before the probe claim", "probe_stale_authority");
  }
  const [connectionPre] = await getDb().select({
    configVersion: providerConnections.configVersion,
    credentialVersion: providerConnectionCredentials.credentialVersion,
  }).from(providerConnections).innerJoin(providerConnectionCredentials, and(
    eq(providerConnectionCredentials.serverId, providerConnections.serverId),
    eq(providerConnectionCredentials.connectionId, providerConnections.id),
  )).where(and(
    eq(providerConnections.serverId, input.serverId),
    eq(providerConnections.id, intentPre.connectionId),
  )).limit(1);
  const drifted = !connectionPre
    || connectionPre.configVersion !== intentPre.configVersion
    || connectionPre.credentialVersion !== intentPre.credentialVersion;
  if (drifted) {
    await closeProbeTerminalOutside(asProviderProbeId(intentPre.id), "stale_authority");
    throw new ProviderProbeError("Provider connection changed before the probe claim", "probe_stale_authority");
  }
  const connectionId = await intentConnectionId(input.serverId, input.probeId);
  const preRead = await resolveProviderConnectionProbeMaterialization({
    serverId: input.serverId,
    connectionId,
  });
  try {
    await getDb().transaction(async (tx) => {
      const [intent] = await tx.select().from(providerProbeIntents)
        .where(and(
          eq(providerProbeIntents.id, input.probeId),
          eq(providerProbeIntents.serverId, input.serverId),
        )).limit(1).for("update");
      if (!intent) throw new ProviderProbeError("Provider probe not found", "probe_not_found");
      if (intent.closedAt !== null) {
        throw new ProviderProbeError("Provider probe is closed", "probe_claim_conflict");
      }
      if (intent.expiresAt.getTime() <= currentTimeMs()) {
        throw new ProviderProbeError("Provider probe expired before materialization", "probe_expired");
      }
      const [connection] = await tx.select({
        configVersion: providerConnections.configVersion,
        credentialVersion: providerConnectionCredentials.credentialVersion,
      }).from(providerConnections).innerJoin(providerConnectionCredentials, and(
        eq(providerConnectionCredentials.serverId, providerConnections.serverId),
        eq(providerConnectionCredentials.connectionId, providerConnections.id),
      )).where(and(
        eq(providerConnections.serverId, input.serverId),
        eq(providerConnections.id, intent.connectionId),
      )).limit(1);
      if (
        !connection
        || connection.configVersion !== intent.configVersion
        || connection.credentialVersion !== intent.credentialVersion
      ) {
        throw new ProviderProbeError("Provider connection changed before the probe claim", "probe_stale_authority");
      }
      if (intent.computerId !== input.machineId) {
        throw new ProviderProbeError("Probe belongs to a different Computer", "probe_claim_conflict");
      }
      // The claimant must prove it received THIS dispatch: the claim request
      // id is the command request id frozen at dispatch (F1).
      if (intent.dispatchRequestId !== input.claimRequestId) {
        throw new ProviderProbeError("Claim does not match the frozen dispatch request", "probe_claim_conflict");
      }
      const digest = await providerProbeMaterializationDigest({
        probeId: intent.id,
        machineId: input.machineId,
        claimRequestId: input.claimRequestId,
        connectionEpochId: intent.dispatchEpochId ?? "",
        replicaGeneration: intent.dispatchGeneration ?? "",
        projection: preRead.providerConnection,
        keyEnvNames: preRead.envKeyNames,
      });
      const now = currentDate();
      if (intent.claimMachineId === null) {
        const [claimedRow] = await tx.update(providerProbeIntents).set({
          claimMachineId: input.machineId,
          claimRequestId: input.claimRequestId,
          claimEpochId: intent.dispatchEpochId,
          claimGeneration: intent.dispatchGeneration,
          claimLeasedAt: now,
          materializationDigest: digest,
        }).where(and(
          eq(providerProbeIntents.id, intent.id),
          isNull(providerProbeIntents.claimMachineId),
        )).returning();
        if (!claimedRow) throw new ProviderProbeError("Probe claim raced", "probe_claim_conflict");
        return;
      }
      const sameClaim = intent.claimMachineId === input.machineId
        && intent.claimRequestId === input.claimRequestId
        && intent.claimRequestId === intent.dispatchRequestId
        && intent.claimEpochId === intent.dispatchEpochId
        && intent.claimGeneration === intent.dispatchGeneration;
      const withinLease = intent.claimLeasedAt !== null
        && now.getTime() - intent.claimLeasedAt.getTime() <= PROVIDER_PROBE_MATERIALIZE_LEASE_MS;
      if (!sameClaim || !withinLease || intent.materializationDigest !== digest) {
        throw new ProviderProbeError("Probe materialization already claimed by another carrier", "probe_claim_conflict");
      }
    });
  } catch (error) {
    if (error instanceof ProviderProbeError && error.code === "probe_stale_authority") {
      await closeProbeTerminalOutside(input.probeId, "stale_authority");
    }
    if (error instanceof ProviderProbeError && error.code === "probe_expired") {
      await closeProbeTerminalOutside(input.probeId, "intent_expired");
    }
    throw error;
  }
  return {
    envVars: preRead.envVars,
    providerConnection: preRead.providerConnection,
    authority: {
      connectionEpochId: intentPre.dispatchEpochId ?? "",
      replicaGeneration: intentPre.dispatchGeneration ?? "",
    },
  };
}

async function intentConnectionId(serverId: string, probeId: ProviderProbeId): Promise<string> {
  const [intent] = await getDb().select({ connectionId: providerProbeIntents.connectionId })
    .from(providerProbeIntents).where(and(
      eq(providerProbeIntents.id, probeId),
      eq(providerProbeIntents.serverId, serverId),
    )).limit(1);
  if (!intent) throw new ProviderProbeError("Provider probe not found", "probe_not_found");
  return intent.connectionId;
}

/** Shadow-UI read model: recent durable receipts, newest first, no reply body. */
export async function listProviderProbeReceipts(input: {
  serverId: string;
  connectionId: string;
  limit?: number;
}): Promise<ProviderProbeReceiptList> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const rows = await getDb().select({
    probeId: providerProbeIntents.id,
    computerId: providerProbeIntents.computerId,
    runtime: providerProbeIntents.runtime,
    model: providerProbeIntents.model,
    configVersion: providerProbeIntents.configVersion,
    credentialVersion: providerProbeIntents.credentialVersion,
    outcome: providerProbeReceipts.outcome,
    category: providerProbeReceipts.category,
    latencyMs: providerProbeReceipts.latencyMs,
    verifiedAt: providerProbeReceipts.verifiedAt,
    runtimeVersion: providerProbeReceipts.runtimeVersion,
    daemonVersion: providerProbeReceipts.daemonVersion,
    computerVersion: providerProbeReceipts.computerVersion,
  }).from(providerProbeReceipts)
    .innerJoin(providerProbeIntents, eq(providerProbeIntents.id, providerProbeReceipts.probeId))
    .where(and(
      eq(providerProbeIntents.serverId, input.serverId),
      eq(providerProbeIntents.connectionId, input.connectionId),
    ))
    .orderBy(sql`${providerProbeReceipts.verifiedAt} desc`)
    .limit(limit);
  return {
    receipts: rows.map((row) => ({
      probeId: row.probeId,
      computerId: row.computerId,
      runtime: row.runtime,
      model: row.model,
      outcome: row.outcome as ProviderProbeReceiptSummary["outcome"],
      category: (row.category ?? null) as ProviderProbeReceiptSummary["category"],
      latencyMs: row.latencyMs,
      verifiedAt: row.verifiedAt.toISOString(),
      configVersion: row.configVersion,
      credentialVersion: row.credentialVersion,
      runtimeVersion: row.runtimeVersion,
      daemonVersion: row.daemonVersion,
      computerVersion: row.computerVersion,
    })),
  };
}

/** Durable receipt only; an open-but-expired intent is lazily closed (F2). */
export async function readProviderProbe(input: {
  serverId: string;
  connectionId: string;
  probeId: string;
}): Promise<ProviderProbeReceiptView> {
  const [intent] = await getDb().select().from(providerProbeIntents).where(and(
    eq(providerProbeIntents.serverId, input.serverId),
    eq(providerProbeIntents.connectionId, input.connectionId),
    eq(providerProbeIntents.id, input.probeId),
  )).limit(1);
  if (!intent) throw new ProviderProbeError("Provider probe not found", "probe_not_found");
  if (intent.closedAt === null && intent.expiresAt.getTime() <= currentTimeMs()) {
    await closeProbeTerminalOutside(asProviderProbeId(intent.id), "intent_expired");
    const [closed] = await getDb().select().from(providerProbeIntents)
      .where(eq(providerProbeIntents.id, intent.id)).limit(1);
    const receipt = await loadReceipt(intent.id);
    return projectView(closed ?? intent, receipt);
  }
  const receipt = await loadReceipt(intent.id);
  return projectView(intent, receipt);
}
