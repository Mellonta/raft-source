import assert from "node:assert/strict";
import type { Request, Response } from "express";

import { DmTargetResolutionError } from "../services/dmTargetResolutionError";
import { globalJsonServerErrorHandler, respondToDmTargetResolutionError, sendJsonServerError } from "./errorResponse";

function fakeResponse() {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    headersSent: false,
    setHeader: () => res,
    status(code: number) { sent.status = code; return res; },
    json(body: unknown) { sent.body = body; return res; },
  } as unknown as Response;
  return { res, sent };
}

const req = { method: "GET", route: { path: "/x" }, baseUrl: "", originalUrl: "/x" } as unknown as Request;

test("an ambiguous DM target reaches the caller as 409 with its code, not a 500", () => {
  const { res, sent } = fakeResponse();
  globalJsonServerErrorHandler(DmTargetResolutionError.ambiguous("Twin"), req, res, () => {
    throw new Error("must not fall through to the default handler");
  });
  assert.equal(sent.status, 409);
  assert.deepEqual((sent.body as { code: string }).code, "DM_TARGET_AMBIGUOUS");
  assert.match((sent.body as { error: string }).error, /dm:@Twin~agent/);
  assert.match((sent.body as { suggestedNextAction: string }).suggestedNextAction, /dm:@Twin~agent.*dm:@Twin~human/);
});

test("routes that wrap resolution in a generic catch still report the typed error", () => {
  const { res, sent } = fakeResponse();
  sendJsonServerError(req, res, {
    error: "Failed to read history",
    logPrefix: "test",
    err: DmTargetResolutionError.invalidPeerKind("Twin~bot", "bot"),
  });
  assert.equal(sent.status, 400);
  assert.equal((sent.body as { code: string }).code, "DM_TARGET_INVALID_PEER_KIND");
  assert.equal(typeof (sent.body as { suggestedNextAction?: unknown }).suggestedNextAction, "string");
});

test("routes with a bespoke catch report the typed error through the shared helper", () => {
  const { res, sent } = fakeResponse();
  assert.equal(respondToDmTargetResolutionError(new Error("other"), res), false);
  assert.equal(sent.status, undefined);
  assert.equal(respondToDmTargetResolutionError(DmTargetResolutionError.ambiguous("Twin"), res), true);
  assert.equal(sent.status, 409);
  assert.equal((sent.body as { code: string }).code, "DM_TARGET_AMBIGUOUS");
});
