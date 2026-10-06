import { useState, useEffect } from "react";
import { Input, Button } from "raft-ui";
import type { FormEvent } from "react";
import { useIntl } from "react-intl";
import { useAuthStore } from "../../store/authStore";
import { RefreshCw, LogOut, KeyRound } from "lucide-react";
import Banner from "../ui/Banner";
import CenteredCardFrame from "./CenteredCardFrame";
import { AuthPageIntro } from "./AuthPageFrame";

interface EmailVerificationPageProps {
  initialToken?: string | null;
}

export default function EmailVerificationPage({ initialToken }: EmailVerificationPageProps) {
  const { formatMessage } = useIntl();
  const verifyEmail = useAuthStore((s) => s.verifyEmail);
  const resendVerification = useAuthStore((s) => s.resendVerification);
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);

  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState("");
  const [resendSuccess, setResendSuccess] = useState(false);
  const [showManualInput, setShowManualInput] = useState(false);
  const [manualToken, setManualToken] = useState("");

  // Auto-verify if token provided via URL
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    if (initialToken) {
      handleVerify(initialToken);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialToken]);

  const handleVerify = async (token: string) => {
    setVerifying(true);
    setError("");
    try {
      await verifyEmail(token);
      setVerified(true);
      // Clean up URL
      const url = new URL(window.location.href);
      url.searchParams.delete("verify");
      window.history.replaceState({}, "", url.pathname + url.hash);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "pages.emailVerification.verifyFailed" }));
    } finally {
      setVerifying(false);
    }
  };

  const handleResend = async () => {
    setResending(true);
    setError("");
    setResendSuccess(false);
    try {
      await resendVerification();
      setResendSuccess(true);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "pages.emailVerification.resendFailed" }));
    } finally {
      setResending(false);
    }
  };

  const handleManualSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (manualToken.trim()) {
      handleVerify(manualToken.trim());
    }
  };

  if (verified) {
    return (
      <CenteredCardFrame>
        <div className="w-full">
          <AuthPageIntro
            title={formatMessage({ id: "pages.emailVerification.verifiedTitle" })}
            description={formatMessage({ id: "pages.emailVerification.verifiedDescription" })}
          />
          <Button
            onClick={() => window.location.reload()}
            size="lg"
            variant="accent"
            className="w-full"
          >
            {formatMessage({ id: "pages.emailVerification.continueToRaft" })}
          </Button>
        </div>
      </CenteredCardFrame>
    );
  }

  return (
    <CenteredCardFrame>
      <div className="w-full">
        <AuthPageIntro title={formatMessage({ id: "pages.emailVerification.checkEmailTitle" })}>
          <p className="mt-2 text-sm text-foreground-muted">
            {formatMessage({ id: "pages.emailVerification.sentLinkTo" })}
          </p>
          <p className="mt-1 font-mono text-sm font-bold">{user?.email}</p>
        </AuthPageIntro>

        {error && (
          <Banner intent="warning" className="mb-4 font-bold">
            {error}
          </Banner>
        )}

        {resendSuccess && (
          <Banner intent="success" className="mb-4 font-bold">
            {formatMessage({ id: "pages.emailVerification.resent" })}
          </Banner>
        )}

        {verifying && (
          <div className="mb-4 text-center text-sm text-foreground-muted">
            {formatMessage({ id: "pages.emailVerification.verifying" })}
          </div>
        )}

        <div className="space-y-3">
          <Button
            onClick={handleResend}
            disabled={resending}
            size="lg"
            variant="accent"
            className="w-full"
          >
            <RefreshCw size={16} className={resending ? "animate-spin" : ""} />
            {resending
              ? formatMessage({ id: "pages.emailVerification.sending" })
              : formatMessage({ id: "pages.emailVerification.resendAction" })}
          </Button>

          {/* Manual token entry */}
          <div className="text-center">
            <button
              type="button"
              onClick={() => setShowManualInput(!showManualInput)}
              className="text-sm text-foreground-muted underline hover:text-foreground-strong"
            >
              <KeyRound size={12} className="inline mr-1" />
              {showManualInput
                ? formatMessage({ id: "pages.emailVerification.hideManualEntry" })
                : formatMessage({ id: "pages.emailVerification.enterCodeManually" })}
            </button>
          </div>

          {showManualInput && (
            <form onSubmit={handleManualSubmit} className="flex gap-2">
              <Input
                type="text"
                className="flex-1"
                value={manualToken}
                onChange={(e) => setManualToken(e.target.value)}
                placeholder={formatMessage({ id: "pages.emailVerification.tokenPlaceholder" })}
              />
              <Button size="sm"
                type="submit"
                variant="success"
                disabled={verifying || !manualToken.trim()}
              >
                {verifying ? "…" : formatMessage({ id: "pages.emailVerification.verifyAction" })}
              </Button>
            </form>
          )}

          <Button
            variant="outline"
            size="lg"
            className="w-full"
            onClick={() => logout()}
          >
            <LogOut size={14} />
            {formatMessage({ id: "pages.emailVerification.logOut" })}
          </Button>
        </div>
      </div>
    </CenteredCardFrame>
  );
}
