import { Component, StrictMode, useEffect, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { currentTimeMs } from "@botiverse/raft-shared";
import { installGlobalClientErrorReporters, reportClientError } from "./utils/clientErrorTrace";
import { ThemeProvider } from "raft-ui";
import { LocaleProvider } from "./i18n/LocaleProvider";
import { IntlProviderWrapper } from "./i18n/IntlProviderWrapper";
import { AppProviders } from "./AppProviders";
import App from "./App";
import ServiceWorkerNavigationBridge from "./components/pwa/ServiceWorkerNavigationBridge";
import "./index.css";
import { isDynamicImportFailure } from "./utils/dynamicImportRecovery";
import {
  reportUpdateGateDecision,
  reportUpdateGateDecisionBeforeUnload,
} from "./utils/updateGateTrace";
import type {
  UpdateGateTriggerSource,
} from "./utils/updateGateTrace";
import { registerPushServiceWorker, supportsPushNotifications } from "./utils/pushNotifications";
import { assertOfflineBundleStart } from "./utils/offlineBundleHost";
import { cleanBrowserStateForRecovery } from "./utils/serviceWorkerRecovery";
import { installExternalTranslationGuard } from "./utils/externalTranslationGuard";
import RootErrorFallback from "./components/errors/RootErrorFallback";
import {
  AppRefreshRequiredScreen,
  AppRefreshWarningBanner,
} from "./components/errors/AppUpdateGate";
import "./buildIdentity";
import {
  bootstrapDesktopHandshake,
  renderDesktopHandshakeRecovery,
} from "./desktopHandshake";
import { installDesktopServerWindowBinding } from "./desktopServerWindow";
import { installDesktopServerTitleBinding } from "./desktopServerTitle";
import "./testHooks"; // attaches window.__SLOCK_E2E__ only when built with VITE_E2E=true
import { trackVisualViewport } from "./utils/visualViewport";

const desktopHandshake = bootstrapDesktopHandshake();
installDesktopServerWindowBinding(desktopHandshake);
installDesktopServerTitleBinding(desktopHandshake);
void desktopHandshake.catch((error) => {
  console.error("[Raft Desktop] handshake failed", error);
  renderDesktopHandshakeRecovery();
});

// Local dev tools must be installed before React's first render. Gate the render
// on them rather than using top-level await: any TLA in the module graph makes
// Rolldown turn off common-chunk merging for the whole production build.
const localDevToolsReady = import.meta.env.DEV
  ? import("./devtools/localReactDevTools").then(({ installLocalReactDevTools }) => installLocalReactDevTools())
  : null;

if (supportsPushNotifications()) {
  void registerPushServiceWorker();
}

// Keyboard-only visualViewport pinning (#5888 / #725): trackVisualViewport
// writes --vv-height only while a text field is focused and the visual
// viewport is substantially shorter than the layout viewport. Task #15
// still owns the no-keyboard path (CSS 100dvh / fixed #root) — we do not
// reintroduce always-on JS height pinning that left the PWA bottom gap.
trackVisualViewport();
installExternalTranslationGuard();

const APP_REFRESH_REQUIRED_EVENT = "raft:app-refresh-required";
let appRefreshRequired = false;
let appRefreshTriggerSource: UpdateGateTriggerSource = "error_boundary";

async function clearAssetCacheAndReload() {
  reportUpdateGateDecision({
    action: "recovery_started",
    reason: "user_recover",
    triggerSource: appRefreshTriggerSource,
  });
  let cleanupFailureCount = 0;
  let serviceWorkerCount = 0;
  let assetCacheCount = 0;
  try {
    // Does nothing when the page was loaded from an offline bundle; see cleanBrowserStateForRecovery.
    const result = await cleanBrowserStateForRecovery();
    serviceWorkerCount = result.serviceWorkerCount;
    assetCacheCount = result.assetCacheCount;
    cleanupFailureCount += result.failureCount;
  } catch (error) {
    cleanupFailureCount += 1;
    console.warn("[RootErrorBoundary] app refresh cache cleanup failed", error);
  } finally {
    await reportUpdateGateDecisionBeforeUnload({
      action: "recovery_finished",
      reason: cleanupFailureCount === 0 ? "cleanup_completed" : "cleanup_partial_failure",
      triggerSource: appRefreshTriggerSource,
      cleanupFailureCount,
      serviceWorkerCount,
      assetCacheCount,
    });
    const url = new URL(window.location.href);
    url.searchParams.set("raft_recover", String(currentTimeMs()));
    window.location.replace(url.toString());
  }
}

function requestAppRefreshPrompt(error: unknown, triggerSource: UpdateGateTriggerSource): boolean {
  try {
    if (typeof window !== "undefined" && isDynamicImportFailure(error)) {
      reportUpdateGateDecision({
        action: "detected",
        reason: "dynamic_import_failure",
        triggerSource,
      });
      appRefreshTriggerSource = triggerSource;
      appRefreshRequired = true;
      window.dispatchEvent(new CustomEvent(APP_REFRESH_REQUIRED_EVENT));
      return true;
    }
  } catch (promptError) {
    console.warn("[RootErrorBoundary] app refresh prompt guard failed", promptError);
  }
  return false;
}

if (typeof window !== "undefined") {
  window.addEventListener("vite:preloadError", (event) => {
    const payload = (event as Event & { payload?: unknown }).payload ?? event;
    requestAppRefreshPrompt(payload, "vite_preload_error");
    // Do not cancel this event. Vite treats a canceled preload error as
    // handled and resolves the failed import to undefined. React.lazy then
    // masks the useful chunk error with "reading 'default'" instead of
    // letting the root boundary show the refresh recovery screen.
  });
}

type RootErrorBoundaryState = {
  error: Error | null;
  info: ErrorInfo | null;
  refreshRequired: boolean;
  refreshWarningVisible: boolean;
  refreshPromptDismissed: boolean;
};

class RootErrorBoundary extends Component<{ children: ReactNode }, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = {
    error: null,
    info: null,
    refreshRequired: appRefreshRequired,
    refreshWarningVisible: false,
    refreshPromptDismissed: false,
  };
  componentDidMount() {
    if (typeof window === "undefined") return;
    window.addEventListener(APP_REFRESH_REQUIRED_EVENT, this.handleRefreshRequired);
    if (this.state.refreshRequired) {
      reportUpdateGateDecision({
        action: "prompt_shown",
        reason: "dynamic_import_failure",
        triggerSource: appRefreshTriggerSource,
      });
    }
  }
  componentWillUnmount() {
    if (typeof window === "undefined") return;
    window.removeEventListener(APP_REFRESH_REQUIRED_EVENT, this.handleRefreshRequired);
  }
  handleRefreshRequired = () => {
    if (this.state.refreshPromptDismissed) {
      reportUpdateGateDecision({
        action: "prompt_suppressed",
        reason: "dismissed_prompt",
        triggerSource: appRefreshTriggerSource,
      });
      this.setState({ error: null, info: null, refreshRequired: false, refreshWarningVisible: true });
      return;
    }
    reportUpdateGateDecision({
      action: "prompt_shown",
      reason: "dynamic_import_failure",
      triggerSource: appRefreshTriggerSource,
    });
    this.setState({ error: null, info: null, refreshRequired: true });
  };
  handleContinueAnyway = () => {
    reportUpdateGateDecision({
      action: "continued",
      reason: "user_continue",
      triggerSource: appRefreshTriggerSource,
    });
    this.setState({
      error: null,
      info: null,
      refreshRequired: false,
      refreshWarningVisible: true,
      refreshPromptDismissed: true,
    });
  };
  handleRecoverAndRefresh = () => {
    void clearAssetCacheAndReload();
  };
  componentDidCatch(error: Error, info: ErrorInfo) {
    if (isDynamicImportFailure(error) && this.state.refreshPromptDismissed) {
      reportUpdateGateDecision({
        action: "detected",
        reason: "dynamic_import_failure",
        triggerSource: "later_action",
      });
      reportUpdateGateDecision({
        action: "prompt_shown",
        reason: "dynamic_import_failure",
        triggerSource: "later_action",
      });
      appRefreshTriggerSource = "later_action";
      this.setState({ error: null, info: null, refreshRequired: true, refreshWarningVisible: false });
      console.warn("[RootErrorBoundary] stale app build detected after later action");
      return;
    }
    if (requestAppRefreshPrompt(error, "error_boundary")) {
      this.setState({ error: null, info: null, refreshRequired: true, refreshWarningVisible: false });
      console.warn("[RootErrorBoundary] stale app build detected; showing refresh prompt");
      return;
    }
    this.setState({ error, info, refreshRequired: false, refreshWarningVisible: false });
    console.error("[RootErrorBoundary]", error, info.componentStack);
    reportClientError({ source: "error_boundary", error, componentStack: info.componentStack });
  }
  render() {
    const root = typeof document !== "undefined" ? document.documentElement : null;
    const theme = root?.dataset.theme === "elegant" ? "elegant" : "brutal";
    const mode = root?.classList.contains("dark") ? "dark" : "light";

    // RootErrorBoundary sits above AppThemeProvider and LocaleProvider; wrap intl-backed
    // and RUI fallbacks so formatMessage resolves the user's persisted display locale
    // and RUI components resolve the active theme/mode from DOM without touching app stores.
    if (this.state.refreshRequired) {
      return (
        <ThemeProvider theme={theme} mode={mode} syncDom={false}>
          <LocaleProvider>
            <IntlProviderWrapper>
              <AppRefreshRequiredScreen
                onContinueAnyway={this.handleContinueAnyway}
                onRecoverAndRefresh={this.handleRecoverAndRefresh}
              />
            </IntlProviderWrapper>
          </LocaleProvider>
        </ThemeProvider>
      );
    }

    if (this.state.error) {
      return (
        <ThemeProvider theme={theme} mode={mode} syncDom={false}>
          <LocaleProvider>
            <IntlProviderWrapper>
              <RootErrorFallback
                error={this.state.error}
                componentStack={this.state.info?.componentStack}
              />
            </IntlProviderWrapper>
          </LocaleProvider>
        </ThemeProvider>
      );
    }
    return (
      <>
        {this.state.refreshWarningVisible ? (
          <ThemeProvider theme={theme} mode={mode} syncDom={false}>
            <LocaleProvider>
              <IntlProviderWrapper>
                <AppRefreshWarningBanner onRefresh={this.handleRecoverAndRefresh} />
              </IntlProviderWrapper>
            </LocaleProvider>
          </ThemeProvider>
        ) : null}
        {this.props.children}
      </>
    );
  }
}

// A host injection that is present but invalid is a failed offline start: show the
// root error screen instead of running as an ordinary page. The host's own
// timeout then falls back to the last good bundle.
function OfflineBundleStartGate() {
  assertOfflineBundleStart();
  return null;
}

// E2E-only probe for calibrating the root error boundary in prod-like preview.
function E2ERenderErrorProbe() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (import.meta.env.VITE_E2E !== "true") return undefined;
    const e2e = window.__SLOCK_E2E__;
    if (!e2e) return undefined;
    e2e.triggerRenderError = (nextMessage = "e2e-render-error") => setMessage(nextMessage);
    return () => {
      if (e2e.triggerRenderError) delete e2e.triggerRenderError;
    };
  }, []);

  if (message) throw new Error(message);
  return null;
}

installGlobalClientErrorReporters();

const renderRoot = () => ReactDOM.createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <OfflineBundleStartGate />
      {import.meta.env.VITE_E2E === "true" ? <E2ERenderErrorProbe /> : null}
      {/* Root composition lives in AppProviders — shared with the desktop
          shell, never re-listed here (see that file). */}
      <AppProviders insideRouter={<ServiceWorkerNavigationBridge />}>
        <App />
      </AppProviders>
    </RootErrorBoundary>
  </StrictMode>
);

if (localDevToolsReady) void localDevToolsReady.then(renderRoot);
else renderRoot();
