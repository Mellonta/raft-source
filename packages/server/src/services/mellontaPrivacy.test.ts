import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { noopTracer } from "@botiverse/raft-shared";
import { createServerTracerFromEnv } from "../tracing/serverTracer";
import { createProductEventSinkFromEnv } from "./productEventScopeDbWriter";
import { decideProductAnalyticsGate } from "./productAnalyticsGate";
import { recordActionCardEvent, recordOnboardingWizardEvent } from "./productEventsService";
import { isProductFeedbackConfigured, submitProductFeedback } from "./productFeedbackService";
import { isProductFeedbackConversationConfigured, listProductFeedbackTickets } from "./productFeedbackConversationService";
import { isProductFeedbackRouteConfigured, ensureProductFeedbackRouteBinding } from "./productFeedbackRouteBindingService";
import { getLatestComputerVersion } from "./computerVersionService";
import { evaluateBroadcastPolicy } from "./computerBroadcastPolicyService";
import { lookupLatestAsset } from "../routes/mobileDownload";
import { otlpRelayHandler } from "../routes/otlpRelay";
import { createScopeAttestation } from "../lib/scopeAttestation";
import { isNewsletterSyncConfigured, syncNewsletterSignup } from "./newsletterService";
import { __setEmailDeliveryObserverForTests, sendAppReviewRequestEmail } from "./emailService";

const ENV = {
  SLOCK_TRACE_OTLP_ENDPOINT: "https://vendor.test/traces",
  RAFT_TRACE_SCOPEDB_SINK: "on",
  SCOPEDB_TRACE_EVENTS_ENDPOINT: "https://vendor.test/traces",
  SCOPEDB_TRACE_EVENTS_WRITE_KEY: "test",
  SCOPEDB_PRODUCT_ENDPOINT: "https://vendor.test/product",
  SCOPEDB_PRODUCT_WRITE_KEY: "test",
  HANDS_FEEDBACK_BASE_URL: "https://vendor.test",
  HANDS_FEEDBACK_APP_SLUG: "raft-web",
  HANDS_FEEDBACK_CLIENT_KEY: "test",
  HANDS_FEEDBACK_APP_TOKEN: "test",
  HANDS_FEEDBACK_REPORTER_ID_SECRET: "test",
  HANDS_FEEDBACK_APP_ID: "850a1eca-2664-4e44-9020-51fbdf7a8a70",
  HANDS_FEEDBACK_CONVERSATION_APP_TOKEN: "test",
  HANDS_FEEDBACK_CONVERSATION_CREDENTIAL_REVISION: "test",
  HANDS_FEEDBACK_CURSOR_SECRET: "test",
  HANDS_FEEDBACK_REPORTER_INTEGRATION_ID: "44444444-4444-4444-8444-444444444444",
  HANDS_FEEDBACK_ROUTE_SUBJECT_KEY_ID: "v1",
  HANDS_FEEDBACK_ROUTE_SUBJECT_ROOT: Buffer.alloc(32, 1).toString("base64url"),
};
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); __setEmailDeliveryObserverForTests(null); });

test("configured analytics and trace exporters cannot collect or send", async () => {
  vi.useFakeTimers();
  const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be used"));
  const runtime = createServerTracerFromEnv(ENV);
  assert.equal(runtime.tracer, noopTracer);
  await runtime.shutdown();
  assert.equal(createProductEventSinkFromEnv(ENV), null);
  assert.deepEqual(decideProductAnalyticsGate({ analyticsId: "id", shareUsageData: true, workspaceEnabled: true }), {
    recordAllowed: false, analyticsId: null, clientEventsAllowed: false,
  });
  // Deliberately incomplete inputs: these must return before touching the database.
  await recordActionCardEvent({ cardId: "private", eventType: "action_card.open" });
  await recordOnboardingWizardEvent({ serverId: "private", eventType: "onboarding_wizard.completed", actor: { type: "human", id: "private" }, metadata: { step_id: "create-agent", wizard_version: "1", session_id: "private" } });
  assert.equal(vi.getTimerCount(), 0);
  assert.equal(request.mock.calls.length, 0);
});

test("feedback and reporter registration cannot send even with every credential configured", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("network must not be used"));
  assert.equal(isProductFeedbackConfigured(ENV), false);
  assert.equal(isProductFeedbackConversationConfigured(ENV), false);
  assert.equal(isProductFeedbackRouteConfigured(ENV), false);
  await assert.rejects(submitProductFeedback({ submissionId: "id", kind: "problem", message: "private", contact: null, userId: "private", metadata: { clientKind: "web", platform: "web" }, attachments: [] }, { env: ENV, fetchImpl }));
  await assert.rejects(listProductFeedbackTickets({ userId: "private", reporterId: "private", limit: 10, env: ENV, fetchImpl }));
  await assert.rejects(ensureProductFeedbackRouteBinding({ userId: "private", env: ENV, fetchImpl }));
  assert.equal(fetchImpl.mock.calls.length, 0);
});

test("release lookups and broadcasts stay offline even when the feature flag is enabled", async () => {
  const fetchImpl = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be used"));
  assert.equal(await getLatestComputerVersion(), null);
  const decision = await evaluateBroadcastPolicy({ source: null, platform: null, now: new Date() }, { fetchFn: fetchImpl, isBroadcastEnabled: () => true });
  assert.equal(decision.reasonCode, "broadcast_disabled");
  assert.equal((await lookupLatestAsset("android", { fetch: fetchImpl })).outcome, "not_configured");
  assert.equal(fetchImpl.mock.calls.length, 0);
});

test("older clients cannot obtain diagnostic capabilities or relay traces", async () => {
  vi.stubEnv("SCOPE_ATTESTATION_SECRET", "configured-secret");
  assert.throws(() => createScopeAttestation({ v: 1, typ: "scope-attestation", scope: "web-trace-batch:create", sub: "private", serverId: "private", nonce: "id", exp: 9999999999 }), /disabled/);
  const fetchImpl = vi.fn<typeof fetch>();
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  await otlpRelayHandler({} as never, res as never, { targetUrl: "https://vendor.test", authorization: "configured", fetch: fetchImpl });
  assert.equal(res.status.mock.calls[0][0], 403);
  assert.equal(fetchImpl.mock.calls.length, 0);
});

test("signup marketing and vendor review emails are disabled", async () => {
  vi.stubEnv("RESEND_API_KEY", "test");
  vi.stubEnv("RESEND_NEWSLETTER_SEGMENT_ID", "test");
  const sent = vi.fn();
  __setEmailDeliveryObserverForTests(sent);
  assert.equal(isNewsletterSyncConfigured(), false);
  assert.deepEqual(await syncNewsletterSignup({ id: "private", email: "private@example.test", name: "private" }), { status: "skipped", reason: "not_configured" });
  assert.equal(await sendAppReviewRequestEmail({} as never), null);
  assert.equal(sent.mock.calls.length, 0);
});
