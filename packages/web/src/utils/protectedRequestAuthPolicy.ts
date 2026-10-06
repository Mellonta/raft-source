import { getAuthVerdict } from "./authVerdict";
import type { AuthRestoreState } from "./authRestoreMachine";
import { authStatusBucket, emitAuthTrace, emitAuthTraceAndFlush } from "./webAuthTrace";

export type ProtectedRequestAuthFailureAction =
  | "keep-session"
  | "defer-to-auth-restore"
  | "logout"
  /**
   * task #632: the caller never had a session — neither token is present — so a
   * 401 is the ordinary answer to an unauthenticated request, not a session
   * ending. Reject the request and leave the page alone.
   */
  | "no-session";

export function getProtectedRequestAuthFailureAction(params: {
  status: number | undefined;
  hasRefreshToken: boolean;
  /**
   * task #632. Required rather than optional: every caller has to say which
   * world it is in, because the difference between "your session ended" and
   * "you never had one" is exactly what used to be lost here.
   */
  hasAccessToken: boolean;
  initialized: boolean;
  restoreState: AuthRestoreState;
  authRefreshAttemptId?: string;
}): ProtectedRequestAuthFailureAction {
  const verdict = getAuthVerdict({
    signal: {
      type: "refresh_failed",
      status: params.status,
      hasRefreshToken: params.hasRefreshToken,
    },
    initialized: params.initialized,
    restoreState: params.restoreState,
  });

  // task #632. `getAuthVerdict` answers "this session failed to refresh". For a
  // visitor on a public page that question does not apply: there is no session
  // to end, so its `logout` is the right answer to the wrong question. Decide
  // that here rather than inside the verdict, whose inputs are all about an
  // existing session.
  //
  // Note the narrow condition. An expired session still holds at least one
  // token, so the session-ended path is untouched.
  //
  // `restoreState === "authenticated"` is the third term and it is load-bearing
  // (@Josh's review): a tab whose sibling logged out sees the SAME token inputs
  // as a visitor — both absent — because a deletion does not propagate
  // (`authTokenSync` emits only when both tokens are present, and its channel
  // carries `tokens-updated` only). Without this term that tab would stop being
  // redirected and would sit on a page that looks signed in while every request
  // 401s. Its restore state still says `authenticated`, which is exactly the
  // "this tab had a session" fact the tokens no longer carry. A true visitor
  // boots to `signed_out`.
  const hadSession = params.hasRefreshToken
    || params.hasAccessToken
    || params.restoreState === "authenticated";
  const action: ProtectedRequestAuthFailureAction = !hadSession
    ? "no-session"
    : verdict === "keep-session"
      ? "keep-session"
      : verdict === "defer-to-auth-restore"
        ? "defer-to-auth-restore"
        : "logout";

  const traceAttrs = {
    signalType: "refresh_failed",
    status: params.status ?? null,
    statusBucket: authStatusBucket(params.status),
    hasRefreshToken: params.hasRefreshToken,
    hasAccessToken: params.hasAccessToken,
    initialized: params.initialized,
    restoreState: params.restoreState,
    authVerdict: verdict,
    // Both are recorded: when they disagree, the trace shows the verdict that
    // would have fired and the reason it did not.
    protectedRequestAction: action,
    routeFamily: "protected_request",
    authRefreshAttemptId: params.authRefreshAttemptId,
  } as const;
  // Flush-before-unload exists to outrun the navigation. The verdict says the
  // session is terminal; only the action says whether we actually unload, and
  // task #632's `no-session` overrides a terminal verdict and navigates nowhere
  // — so there would be nothing for the urgent flush to outrun.
  const terminalVerdict = verdict === "logout";
  const willUnload = terminalVerdict && action === "logout";
  if (willUnload) {
    emitAuthTraceAndFlush("slock.auth.verdict", traceAttrs);
  } else {
    emitAuthTrace("slock.auth.verdict", traceAttrs);
  }

  return action;
}
