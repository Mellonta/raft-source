import { privacyModeEnabled } from "@botiverse/raft-shared/src/privacyMode";
import express, { Router, type ErrorRequestHandler, type RequestHandler, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { PUBLIC_SERVER_VISIT_ENTRIES } from "@botiverse/raft-shared";
import { getBearerAccessUserId } from "../middleware/auth";
import { countIngest, getProductEventSink, getPublicVisitorSink } from "../services/productEventIngest";
import { productEventContext } from "../services/productEventContext";
import { countPublicVisit, recordPublicVisit } from "../services/publicVisitCounts";

/**
 * POST /api/public-visits/:slug — count-only beacon from a public server page
 * (services/publicVisitCounts.ts). No login needed: anonymous visitors are the
 * point. It can only make a count bigger, never write content.
 *
 * Always 204 with an empty body, whatever happened (unknown or private slug,
 * flag off, throttled, malformed, dropped), so the endpoint cannot tell a
 * caller which slugs exist.
 */
export const publicVisitsRouter: ExpressRouter = Router();

export const PUBLIC_VISITS_PATH = "/api/public-visits/:slug";
export const PUBLIC_VISIT_MAX_BODY_BYTES = 1024;

/**
 * Mounted in app.ts BEFORE the global JSON parser, so a large body is refused
 * while parsing instead of after (Tenny's review).
 */
export const publicVisitsBodyParser: RequestHandler = express.json({ limit: PUBLIC_VISIT_MAX_BODY_BYTES });

/** Too large or not JSON: the same empty 204 as every other outcome. */
export const publicVisitsBodyErrorHandler: ErrorRequestHandler = (_err, _req, res, _next) => {
  if (!privacyModeEnabled()) countIngest("rejected_malformed", 1);
  res.set("Cache-Control", "no-store");
  res.status(204).end();
};

// Source fields are bounded here and checked against the registry by
// publicVisitCounts.ts, which drops a bad one and keeps the visit.
const visitSchema = z.object({
  uuid: z.uuid(),
  event: z.enum(["public_page_viewed", "public_page_channel_opened", "public_page_thread_opened"]),
  channel_id: z.uuid().optional(),
  thread_channel_id: z.uuid().optional(),
  entry: z.enum(PUBLIC_SERVER_VISIT_ENTRIES).optional(),
  referrer_domain: z.string().max(253).optional(),
  utm_source: z.string().max(64).optional(),
  utm_medium: z.string().max(64).optional(),
  utm_campaign: z.string().max(64).optional(),
  // After cookie consent only; a malformed one is dropped, the visit kept.
  anonymous_id: z.string().max(64).optional(),
}).strict();

// The web app calls the API from its own subdomain (app.raft.build ->
// api.raft.build), so browsers send `same-site`; `cross-site` and missing
// headers are dropped. Not a security boundary: it filters stray cross-site
// requests and the crudest scripts for free.
const ACCEPTED_FETCH_SITES = new Set(["same-origin", "same-site"]);

publicVisitsRouter.post("/:slug", async (req, res) => {
  try {
    if (privacyModeEnabled()) return;
    if (!ACCEPTED_FETCH_SITES.has(req.get("sec-fetch-site") ?? "")) {
      countIngest("public_visit_not_same_site", 1);
      return;
    }
    const parsed = visitSchema.safeParse(req.body);
    if (!parsed.success) {
      countIngest("rejected_malformed", 1);
      return;
    }
    const {
      uuid,
      event,
      channel_id: channelId,
      thread_channel_id: threadChannelId,
      anonymous_id: anonymousId,
      ...source
    } = parsed.data;
    // Signed in only if the bearer token verifies; the client cannot claim it.
    const userId = await getBearerAccessUserId(req.get("authorization"));
    const outcome = await recordPublicVisit(
      {
        slug: req.params.slug,
        uuid,
        event,
        channelId: channelId ?? null,
        threadChannelId: threadChannelId ?? null,
        userId,
        source,
        anonymousId: anonymousId ?? null,
        context: productEventContext({ userAgent: req.get("user-agent"), country: req.get("cloudfront-viewer-country") }),
      },
      getProductEventSink(req.app),
      Date.now(),
      getPublicVisitorSink(req.app),
    );
    countPublicVisit(outcome);
  } catch (err) {
    console.warn("[public-visits] dropped:", err instanceof Error ? err.name : "unknown");
  } finally {
    res.set("Cache-Control", "no-store");
    res.status(204).end();
  }
});
