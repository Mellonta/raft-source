import { Router, type Router as RouterType } from "express";
import { getDb } from "../db/index";
import { legacyProductEventsAllowed, resolveProductAnalyticsGate } from "../services/productAnalyticsGate";
import {
  buildClientEventRows,
  clientEventBatchSchema,
  countIngest,
  getProductEventSink,
} from "../services/productEventIngest";
import * as productEventsService from "../services/productEventsService";
import { sendJsonServerError } from "./errorResponse";

export const productEventsRouter: RouterType = Router();

const ONBOARDING_WIZARD_EVENT_TYPES = new Set([
  "onboarding_wizard.step_shown",
  "onboarding_wizard.primary_clicked",
  "onboarding_wizard.skip_clicked",
  "onboarding_wizard.dismissed",
  "onboarding_wizard.completed",
  "onboarding_wizard.error",
]);

const ONBOARDING_WIZARD_STEP_IDS = new Set([
  "add-computer",
  "detect-runtime",
  "create-agent",
  "referral-source",
  "invite-teammates",
  "join-community",
]);

function shortField(value: unknown, maxLength = 64): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

// POST /api/product-events/onboarding-wizard
//
// Client-emitted interaction events for the owner onboarding wizard. This is
// intentionally narrower than a generic event ingest endpoint: event_type and
// step_id are whitelisted, metadata is reduced to low-cardinality fields, and
// `subject_id` is always the current server id from `requireServer`.
productEventsRouter.post("/onboarding-wizard", async (req, res) => {
  try {
    const body = (req.body ?? {}) as {
      eventType?: unknown;
      idempotencyKey?: unknown;
      metadata?: unknown;
    };

    if (
      typeof body.eventType !== "string" ||
      !ONBOARDING_WIZARD_EVENT_TYPES.has(body.eventType)
    ) {
      res.status(400).json({
        error:
          "eventType must be one of onboarding_wizard.step_shown, onboarding_wizard.primary_clicked, onboarding_wizard.skip_clicked, onboarding_wizard.dismissed, onboarding_wizard.completed, onboarding_wizard.error",
      });
      return;
    }

    const rawMetadata = (body.metadata ?? {}) as Record<string, unknown>;
    const stepId = shortField(rawMetadata.step_id);
    if (!stepId || !ONBOARDING_WIZARD_STEP_IDS.has(stepId)) {
      res.status(400).json({ error: "metadata.step_id must be a tracked onboarding wizard step" });
      return;
    }

    const wizardVersion = shortField(rawMetadata.wizard_version) ?? "unknown";
    const sessionId = shortField(rawMetadata.session_id) ?? "unknown";
    const metadata: productEventsService.OnboardingWizardEventMetadata = {
      step_id: stepId as productEventsService.OnboardingWizardStepId,
      wizard_version: wizardVersion,
      session_id: sessionId,
    };

    const action = shortField(rawMetadata.action);
    const result = shortField(rawMetadata.result);
    const reason = shortField(rawMetadata.reason);
    if (action) metadata.action = action;
    if (result) metadata.result = result;
    if (reason) metadata.reason = reason;
    if (
      typeof rawMetadata.latency_ms === "number" &&
      rawMetadata.latency_ms >= 0 &&
      rawMetadata.latency_ms < 1_000_000
    ) {
      metadata.latency_ms = Math.round(rawMetadata.latency_ms);
    }

    const idempotencyKey = shortField(body.idempotencyKey, 128);

    // RFC-067 controls: an explicit "no" (workspace switch off, or the user
    // turned "Share usage data" off) means nothing is recorded.
    if (!(await legacyProductEventsAllowed(getDb(), { userId: req.userId!, serverId: req.serverId! }))) {
      res.status(204).end();
      return;
    }

    await productEventsService.recordOnboardingWizardEvent({
      serverId: req.serverId!,
      eventType: body.eventType as productEventsService.OnboardingWizardEventType,
      actor: { type: "human", id: req.userId! },
      source: "web",
      idempotencyKey,
      metadata,
    });

    res.status(204).end();
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to record product event",
      logPrefix: "[product-events] unexpected error:",
      err,
    });
  }
});

// RFC-067 client behavior events. Clients ask first and send only when this
// says yes (the user's "share usage data" choice, their analytics id, the
// workspace switch, and a configured store); the batch route enforces the same
// gate again.
//
// GET /api/product-events/config
productEventsRouter.get("/config", async (req, res) => {
  try {
    const gate = await resolveProductAnalyticsGate(getDb(), { userId: req.userId!, serverId: req.serverId! });
    res.json({ clientEventsAllowed: gate.clientEventsAllowed && getProductEventSink(req.app) !== null });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to read product event config",
      logPrefix: "[product-events] config error:",
      err,
    });
  }
});

// POST /api/product-events/batch
//
// Always 202 once the body is well-formed: the client drops its batch either
// way. `accepted` is how many rows were queued for the store; counts of what
// was written, lost, gated or rejected live in metrics.
productEventsRouter.post("/batch", async (req, res) => {
  const parsed = clientEventBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    countIngest("rejected_malformed", 1);
    res.status(400).json({ error: "Invalid product event batch" });
    return;
  }
  const batch = parsed.data;
  try {
    const sink = getProductEventSink(req.app);
    if (sink === null) {
      countIngest("unconfigured", batch.events.length);
      res.status(202).json({ accepted: 0 });
      return;
    }
    const gate = await resolveProductAnalyticsGate(getDb(), { userId: req.userId!, serverId: req.serverId! });
    if (!gate.clientEventsAllowed || gate.analyticsId === null) {
      countIngest("gated", batch.events.length);
      res.status(202).json({ accepted: 0 });
      return;
    }
    const { rows, rejected } = buildClientEventRows({
      batch,
      analyticsId: gate.analyticsId,
      serverId: req.serverId!,
      receivedAt: new Date(),
    });
    for (const [reason, count] of Object.entries(rejected)) {
      countIngest(`rejected_${reason as keyof typeof rejected}`, count);
    }
    // Queued for the background writer, which counts written and lost rows.
    sink.enqueue(rows);
    res.status(202).json({ accepted: rows.length });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to record product events",
      logPrefix: "[product-events] batch error:",
      err,
    });
  }
});
