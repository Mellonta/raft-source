/**
 * App login handoff routes (see appLoginService).
 *
 * `POST /api/auth/app-login/start`              — public: app sends returnUri + PKCE challenge.
 * `GET  /api/auth/app-login/requests/:id`       — signed-in web: is the request still usable.
 * `POST /api/auth/app-login/requests/:id/approve` — signed-in web: explicit confirm → code redirect.
 * `POST /api/auth/app-login/requests/:id/deny`  — signed-in web: cancel → error redirect.
 * `POST /api/auth/app-login/complete`           — public: app exchanges code + verifier for a session.
 *
 * Pre-credential surfaces like /api/auth/device, outside the routeAuthPolicy
 * registry by design; mounted behind the auth rate limiter.
 */
import { Router, type Router as RouterType } from "express";
import {
  approveAppLogin,
  denyAppLogin,
  describeAppLogin,
  exchangeAppLoginCode,
  startAppLogin,
} from "../services/appLoginService";
import { requireAuth, signAccessToken } from "../middleware/auth";
import { attachAuthTraceIdentity } from "../middleware/requestObservability";
import * as sessionService from "../services/sessionService";
import * as userService from "../services/userService";
import { getConfiguredAppUrl } from "../config/appUrl";
import { recordAuthSessionIssuedTrace } from "./authRefreshTrace";
import { sendJsonServerError } from "./errorResponse";

export const appLoginRouter: RouterType = Router();

const APP_LOGIN_PATH = "/login/app";

function resolveErrorStatus(error: string): number {
  return error === "request_expired" ? 410 : error === "request_already_resolved" ? 409 : 404;
}

appLoginRouter.post("/start", async (req, res) => {
  try {
    // Clients may also send platform / appEnv (informational, ignored) and
    // codeChallengeMethod, which must be S256 when present.
    const body = (req.body ?? {}) as { returnUri?: unknown; codeChallenge?: unknown; codeChallengeMethod?: unknown };
    if (typeof body.returnUri !== "string" || typeof body.codeChallenge !== "string") {
      res.status(400).json({ error: "returnUri and codeChallenge are required", code: "invalid_request" });
      return;
    }
    if (body.codeChallengeMethod !== undefined && body.codeChallengeMethod !== "S256") {
      res.status(400).json({ error: "codeChallengeMethod must be S256", code: "code_challenge_invalid" });
      return;
    }
    const base = getConfiguredAppUrl();
    if (!base) {
      res.status(503).json({ error: "App login URL is not configured", code: "app_login_url_unavailable" });
      return;
    }
    const started = await startAppLogin({ returnUri: body.returnUri, codeChallenge: body.codeChallenge });
    if (!started.ok) {
      res.status(400).json({ error: "App login request is invalid", code: started.error });
      return;
    }
    const loginUrl = new URL(`${base}${APP_LOGIN_PATH}`);
    loginUrl.searchParams.set("request", started.requestId);
    res.status(201).json({
      requestId: started.requestId,
      loginUrl: loginUrl.toString(),
      expiresAt: started.expiresAt.toISOString(),
    });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to start app login", logPrefix: "api.auth.app-login.start error:", err });
  }
});

appLoginRouter.get("/requests/:id", requireAuth, async (req, res) => {
  try {
    const described = await describeAppLogin(String(req.params.id));
    if (!described.ok) {
      res.status(resolveErrorStatus(described.error)).json({
        error: "App login request is not usable",
        code: described.error,
        ...(described.cancelUrl ? { redirectUrl: described.cancelUrl } : {}),
      });
      return;
    }
    res.json({ expiresAt: described.expiresAt.toISOString() });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to load app login", logPrefix: "api.auth.app-login.describe error:", err });
  }
});

appLoginRouter.post("/requests/:id/approve", requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: "Authentication required", code: "auth_required" });
      return;
    }
    const approved = await approveAppLogin(String(req.params.id), userId);
    if (!approved.ok) {
      res.status(resolveErrorStatus(approved.error)).json({
        error: "App login request is not usable",
        code: approved.error,
        ...(approved.redirectUrl ? { redirectUrl: approved.redirectUrl } : {}),
      });
      return;
    }
    res.json({ redirectUrl: approved.redirectUrl });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to approve app login", logPrefix: "api.auth.app-login.approve error:", err });
  }
});

appLoginRouter.post("/requests/:id/deny", requireAuth, async (req, res) => {
  try {
    const denied = await denyAppLogin(String(req.params.id));
    if (!denied.ok) {
      res.status(resolveErrorStatus(denied.error)).json({ error: "App login request is not usable", code: denied.error });
      return;
    }
    res.json({ redirectUrl: denied.redirectUrl });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to cancel app login", logPrefix: "api.auth.app-login.deny error:", err });
  }
});

appLoginRouter.post("/complete", async (req, res) => {
  try {
    const body = (req.body ?? {}) as { code?: unknown; codeVerifier?: unknown };
    if (typeof body.code !== "string" || typeof body.codeVerifier !== "string") {
      res.status(400).json({ error: "code and codeVerifier are required", code: "invalid_request" });
      return;
    }
    const exchanged = await exchangeAppLoginCode(body.code, body.codeVerifier);
    if (!exchanged.ok) {
      const status = exchanged.error === "code_expired" || exchanged.error === "code_consumed" ? 410
        : exchanged.error === "pkce_mismatch" ? 400
        : 404;
      res.status(status).json({ error: "App login code could not be exchanged", code: exchanged.error });
      return;
    }
    const user = await userService.getUser(exchanged.userId);
    if (!user) {
      res.status(404).json({ error: "App login code could not be exchanged", code: "code_not_found" });
      return;
    }
    const { sessionId, familyId, refreshToken } = await sessionService.createSession(user.id);
    const accessToken = signAccessToken(user.id, familyId);
    attachAuthTraceIdentity(req, { userId: user.id, sessionId, source: "app_login" });
    recordAuthSessionIssuedTrace({ flow: "app_login", userId: user.id, sessionId });
    res.json({ user, accessToken, refreshToken });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to complete app login", logPrefix: "api.auth.app-login.complete error:", err });
  }
});
