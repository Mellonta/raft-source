import { useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { Button } from "raft-ui";
import api from "../api/client";
import { useAuthStore } from "../store/authStore";
import AuthPageFrame, { AuthPageIntro } from "../components/auth/AuthPageFrame";
import SignedInAs from "../components/auth/SignedInAs";
import Banner from "../components/ui/Banner";

// App login handoff (HarmonyOS web login): a native app opened this page with
// `?request=<id>`. The ordinary login has already run (this route is only
// reachable signed in); the user must explicitly confirm the account before
// the app gets a one-time code. The return address is fixed server-side.

type UnusableMessageId = "pages.appLogin.expired" | "pages.appLogin.alreadyUsed" | "pages.appLogin.invalid";

type PageState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "unusable"; messageId: UnusableMessageId; redirectUrl?: string }
  | { kind: "returned"; redirectUrl: string };

/** Leaving for the app's custom scheme; replaceable in tests. */
export const appLoginRedirect = {
  assign: (url: string) => window.location.assign(url),
};

function requestIdFromUrl(): string {
  return new URLSearchParams(window.location.search).get("request") || "";
}

function unusableMessageId(code: string | undefined): UnusableMessageId {
  if (code === "request_expired") return "pages.appLogin.expired";
  if (code === "request_already_resolved") return "pages.appLogin.alreadyUsed";
  return "pages.appLogin.invalid";
}

function unusableState(err: unknown): PageState {
  const data = (err as { response?: { data?: { code?: string; redirectUrl?: string } } })?.response?.data ?? {};
  return { kind: "unusable", messageId: unusableMessageId(data.code), redirectUrl: data.redirectUrl };
}

async function loadRequestState(requestId: string): Promise<PageState> {
  if (!requestId) return { kind: "unusable", messageId: "pages.appLogin.invalid" };
  try {
    await api.get(`/auth/app-login/requests/${encodeURIComponent(requestId)}`);
    return { kind: "ready" };
  } catch (err) {
    return unusableState(err);
  }
}

export default function AppLoginPage() {
  const { formatMessage } = useIntl();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const requestId = useMemo(() => requestIdFromUrl(), []);
  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadRequestState(requestId).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => { cancelled = true; };
  }, [requestId]);

  function returnToApp(redirectUrl: string) {
    setState({ kind: "returned", redirectUrl });
    appLoginRedirect.assign(redirectUrl);
  }

  async function resolve(action: "approve" | "deny") {
    setSubmitting(true);
    try {
      const { data } = await api.post(`/auth/app-login/requests/${encodeURIComponent(requestId)}/${action}`);
      returnToApp(data.redirectUrl);
    } catch (err) {
      setState(unusableState(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (state.kind === "returned") {
    return (
      <AuthPageFrame>
        <div className="w-full" data-testid="app-login-returned">
          <AuthPageIntro
            title={formatMessage({ id: "pages.appLogin.returnedTitle" })}
            description={formatMessage({ id: "pages.appLogin.returnedDescription" })}
          />
          {/* Some browsers drop the automatic custom-scheme jump because it
              runs after an async request; a tap here is a fresh user gesture. */}
          <Button
            type="button"
            onClick={() => appLoginRedirect.assign(state.redirectUrl)}
            size="md"
            variant="accent"
            className="w-full"
            data-testid="app-login-open-app"
          >
            {formatMessage({ id: "pages.appLogin.openApp" })}
          </Button>
        </div>
      </AuthPageFrame>
    );
  }

  if (state.kind === "unusable") {
    const redirectUrl = state.redirectUrl;
    return (
      <AuthPageFrame>
        <div className="w-full" data-testid="app-login-unusable">
          <AuthPageIntro title={formatMessage({ id: "pages.appLogin.title" })} />
          <Banner intent="warning" className="mb-4 font-bold">{formatMessage({ id: state.messageId })}</Banner>
          {redirectUrl ? (
            <Button type="button" onClick={() => returnToApp(redirectUrl)} size="md" variant="outline" className="w-full">
              {formatMessage({ id: "pages.appLogin.backToApp" })}
            </Button>
          ) : null}
        </div>
      </AuthPageFrame>
    );
  }

  return (
    <AuthPageFrame>
      <div className="w-full" data-testid="app-login-confirm">
        <AuthPageIntro
          title={formatMessage({ id: "pages.appLogin.title" })}
          description={<SignedInAs user={user} prefix={formatMessage({ id: "pages.appLogin.signedInAsPrefix" })} suffix="." />}
        />
        <Button
          type="button"
          onClick={() => void resolve("approve")}
          disabled={state.kind !== "ready" || submitting}
          size="md"
          variant="accent"
          className="w-full"
          data-testid="app-login-approve"
        >
          {formatMessage({ id: "pages.appLogin.approve" })}
        </Button>
        <Button
          type="button"
          onClick={() => logout()}
          disabled={submitting}
          size="md"
          variant="outline"
          className="mt-3 w-full"
        >
          {formatMessage({ id: "pages.appLogin.useAnotherAccount" })}
        </Button>
        <Button
          type="button"
          onClick={() => void resolve("deny")}
          disabled={state.kind !== "ready" || submitting}
          size="md"
          variant="ghost"
          className="mt-3 w-full"
          data-testid="app-login-deny"
        >
          {formatMessage({ id: "pages.appLogin.cancel" })}
        </Button>
      </div>
    </AuthPageFrame>
  );
}
