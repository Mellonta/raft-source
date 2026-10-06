// Task #91 route enumeration contract. Every mutating route the app actually registers must appear exactly once in
// ROUTE_AUTHORITY_CLASSIFICATION with a bucket and a one-line reason, and every table row must still be registered.
// The route list comes from runtime registration (see routeRegistrationCapture.ts), cross-checked against Express's
// dispatch stack, so a new router, a chained `.route()`, a subrouter mount or an env-gated mount cannot slip past a
// source-text scan. The adjudicated #91a / #93 lists are pinned by count so moving a route between them is deliberate.
import assert from "node:assert/strict";
import express from "express";
import { installRouteRegistrationCapture } from "./routeRegistrationCapture";
import {
  PINNED_BUCKET_COUNTS,
  ROUTE_AUTHORITY_CLASSIFICATION,
  checkRouteClassification,
  type RouteClassification,
} from "./routeAuthorityClassification";

// Mount every env-gated surface so gated routes are enumerated rather than silently absent.
process.env.SLOCK_SELF_HOSTED_RUNNER_BOOTSTRAP_ENABLED = "true";
delete process.env.SLOCK_DEVICE_LOGIN_ENABLED;

const capture = installRouteRegistrationCapture();
const noop = (_req: unknown, res: { end: () => void }) => res.end();

test("capture positive controls: chained .route(), nested subrouters, array mounts, app.all, unmounted routers", () => {
  const session = capture.session();
  const app = express();
  const sub = express.Router();
  sub.route("/chained").post(noop).put(noop).get(noop);
  sub.delete("/plain/:id", noop);
  const nested = express.Router();
  nested.patch("/deep", noop);
  sub.use("/nested/:x", nested);
  app.use("/mounted", sub);
  app.use(["/a", "/b"], nested);
  app.all("/any", noop);
  app.post(/^\/regex$/, noop);
  const orphan = express.Router();
  orphan.post("/orphan", noop);

  const { routes, problems } = session.collect((app as unknown as { router: object }).router);
  // Express 5 `app.all` registers every HTTP method on the route individually, so each mutating method is enumerated.
  assert.deepEqual(routes.map((route) => `${route.method} ${route.path}`), [
    "DELETE /any",
    "DELETE /mounted/plain/:id",
    "PATCH /a/deep",
    "PATCH /any",
    "PATCH /b/deep",
    "PATCH /mounted/nested/:x/deep",
    "POST /^\\/regex$/",
    "POST /any",
    "POST /mounted/chained",
    "PUT /any",
    "PUT /mounted/chained",
  ]);
  assert.deepEqual(problems, ["unmounted router registers POST /orphan"]);
});

let appRouter: object | undefined;
let appSession: ReturnType<typeof capture.session> | undefined;

test("every registered mutating route is classified exactly once and every table row is registered", async () => {
  appSession = capture.session();
  const { createApp } = await import("../app");
  appRouter = (createApp() as unknown as { router: object }).router;
  const { routes, problems } = appSession.collect(appRouter);

  assert.deepEqual(problems, [], "route capture and dispatch stack must agree, with no unmounted mutating routers");
  const result = checkRouteClassification(routes);
  assert.deepEqual(result.unclassified, [], "registered mutating routes missing from ROUTE_AUTHORITY_CLASSIFICATION");
  assert.deepEqual(result.stale, [], "ROUTE_AUTHORITY_CLASSIFICATION rows that are no longer registered");
  assert.deepEqual(result.duplicates, [], "routes classified more than once");
  assert.deepEqual(result.missingReasons, [], "rows without a one-line reason");
  assert.deepEqual(result.pinnedCounts, PINNED_BUCKET_COUNTS, "adjudicated #91a / #93 bucket counts changed");
  assert.equal(routes.length, ROUTE_AUTHORITY_CLASSIFICATION.length);
});

test("reverse controls: an unclassified route on a mounted router, a dropped row and a stale row all turn red", async () => {
  assert.ok(appSession && appRouter, "depends on the enumeration test having built the app");
  const { agentRouter } = await import("../routes/agents");
  agentRouter.post("/:id/unclassified-structural-probe", noop);
  const { routes, problems } = appSession.collect(appRouter);
  assert.deepEqual(problems, []);
  assert.deepEqual(checkRouteClassification(routes).unclassified, ["POST /api/agents/:id/unclassified-structural-probe"]);

  const dropped = ROUTE_AUTHORITY_CLASSIFICATION.filter((row) => row.route !== "PUT /api/agents/:id/scopes");
  assert.ok(checkRouteClassification(routes, dropped).unclassified.includes("PUT /api/agents/:id/scopes"));

  const staleRow: RouteClassification = { route: "POST /api/agents/:id/no-such-route", bucket: "cat1", reason: "control" };
  assert.deepEqual(checkRouteClassification(routes, [...ROUTE_AUTHORITY_CLASSIFICATION, staleRow]).stale, [staleRow.route]);
});
