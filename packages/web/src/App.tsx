import { Button, Card } from "raft-ui";
import { useEffect, useRef, useState, useMemo } from "react";
import { usePreviewApiTarget } from "./hooks/usePreviewApiTarget";
import { Routes, Route, Navigate, useParams, useNavigate, useLocation } from "react-router-dom";
import { useAuthStore } from "./store/authStore";
import { useIntl } from "react-intl";
import { useLocale } from "./i18n/LocaleProvider";
import { shouldReconcileAccountLocale } from "./i18n/locale";
import { useServerStore } from "./store/serverStore";
import type { CommunityServerSlug } from "./store/serverStore";
import { useAgentStore } from "./store/agentStore";
import { useMachineStore } from "./store/machineStore";
import { serverPersistence } from "./store/serverPersistenceRegistry";
import MobileDownloadChooserPage from "./pages/MobileDownloadChooserPage";
import ChineseCommunityPage from "./pages/ChineseCommunityPage";
import DeviceLoginPage from "./pages/DeviceLoginPage";
import AppLoginPage from "./pages/AppLoginPage";
import HumanLoginSetupPage from "./pages/HumanLoginSetupPage";
import IntegrationInvitePage from "./pages/IntegrationInvitePage";
import { INTEGRATION_INVITE_ROUTE } from "@botiverse/raft-shared";
import AgentConnectionCallbackPage from "./pages/AgentConnectionCallbackPage";
import PublicServerPage from "./pages/PublicServerPage";
import { useChannelStore } from "./store/channelStore";
import type { Channel } from "./store/channelStore";
import { useThreadStore } from "./store/threadStore";
import api from "./api/client";
import PaletteAuditPage from "./pages/PaletteAuditPage";
import AccountBootstrapPreviewPage from "./pages/AccountBootstrapPreviewPage";
import ServerSetupComputerRuntimePreviewPage from "./pages/ServerSetupComputerRuntimePreviewPage";
import ServerSetupProjectionGate from "./components/onboarding/ServerSetupProjectionGate";
import LoginPage from "./components/auth/LoginPage";
import RegisterPage from "./components/auth/RegisterPage";
import AccountIdentitySetupPage from "./components/auth/AccountIdentitySetupPage";
import ForgotPasswordPage from "./components/auth/ForgotPasswordPage";
import ResetPasswordPage from "./components/auth/ResetPasswordPage";
import EmailVerificationPage from "./components/auth/EmailVerificationPage";
import InviteAcceptPage from "./components/auth/InviteAcceptPage";
import SocialAuthCallbackPage from "./components/auth/SocialAuthCallbackPage";
import ServerSelector from "./components/auth/ServerSelector";
import SignedInAs from "./components/auth/SignedInAs";
import ImageLightbox from "./components/ImageLightbox";
import DocumentPreviewHost from "./components/message/DocumentPreviewHost";
import MediaPreviewHost from "./components/message/MediaPreviewHost";
import MainLayout from "./components/layout/MainLayout";
import ThreadWindowRoute from "./components/window/ThreadWindowRoute";
import MessageSelectionShortcut from "./components/message/MessageSelectionShortcut";
import {
  MAX_AUTH_RESTORE_MS,
  getAuthBootstrapView,
  shouldRetryAuthRestore,
} from "./utils/authRestoreMachine";
import { getRestoreTimeoutAction } from "./utils/restoreTimeoutPolicy";
import { shouldRecoverAuthOnBrowserSignal } from "./utils/browserRecoveryPolicy";
import { PENDING_INVITE_STORAGE_KEY, takePendingInviteRedirectPath } from "./utils/socialAuth";
import { requiresAccountProfileSetup } from "./utils/accountProfileSetup";
import { useLastLocationResume } from "./hooks/useLastLocationResume";
import { readServerSurfaceMemory } from "./hooks/useTabRouteMemory";
import { getDesktopServerBootstrapTarget } from "./utils/serverSwitcherNavigation";
import {
  consumeServerSelectionRequest,
  isServerSelectionRequested,
  requestServerSelection,
} from "./utils/serverSelectionRequest";
import {
  isChangePasswordIntentPath,
  serverEntryPath,
} from "./utils/changePasswordNavigation";
import { NavigationDepthTracker, useAppNavigate } from "./hooks/useAppNavigate";
import { useJoinCommunityFlow } from "./hooks/useJoinCommunityFlow";
import {
  CHINESE_COMMUNITY_SERVER_SLUG,
  CHINESE_COMMUNITY_PAGE_PATH,
  DEFAULT_COMMUNITY_SERVER_SLUG,
} from "./utils/communityServers";
import {
  SLOCKDEV_EMAIL,
  SLOCKDEV_PASSWORD,
  getEnvironmentLabelMessageId,
  getPreviewEnvironmentDetails,
  getSlockdevSeedCommand,
  isSlockdevEnvironment,
  shouldAutoLoginSlockdev,
} from "./utils/devMode";
import type {
  AuthView,
} from "./utils/devMode";
import { emitAuthTraceAndFlush } from "./utils/webAuthTrace";
import { jointInviteAcceptErrorMessage } from "./utils/jointChannelLimit";
import { showToast } from "./components/toastBridge";
import DraggableDevOverlay from "./components/dev/DraggableDevOverlay";
import { HIDE_LOCAL_DEV_TOOLS_EVENT } from "./components/dev/devOverlayEvents";
import Tooltip from "./components/ui/Tooltip";
import { Settings2, X } from "lucide-react";
import { isHostShell } from "./embed";
import { readNativeOnboardingGeneration } from "./embed/nativeOnboarding";
import {
  genericAppDocumentTitle,
  getServerRouteDocumentTitle,
  hostShellFallbackDocumentTitle,
  serverRouteChannelId,
  serverRouteDmId,
  serverRouteAgentId,
  serverRouteMachineId,
  useBrowserDocumentTitle,
} from "./utils/browserDocumentTitle";

/** Parse URL search params once */
function getUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const joinMatch = window.location.pathname.match(/^\/join\/([^/?#]+)/);
  return {
    authCallback: params.get("auth_callback"),
    verifyToken: params.get("verify"),
    resetToken: params.get("reset"),
    inviteToken: params.get("invite") || joinMatch?.[1] || null,
  };
}

const deploymentEnv = import.meta.env?.VITE_DEPLOYMENT_ENV;
const isSlockdev = isSlockdevEnvironment(deploymentEnv);
const environmentLabelMessageId = getEnvironmentLabelMessageId(deploymentEnv);

function routeCommunitySlug(value: string | undefined): CommunityServerSlug | null {
  if (value === DEFAULT_COMMUNITY_SERVER_SLUG || value === CHINESE_COMMUNITY_SERVER_SLUG) return value;
  return null;
}

export { requestServerSelection };

function documentTitleChannelLabel(channel: Channel | null | undefined): string | null {
  if (!channel) return null;
  if (channel.type === "dm") {
    const peerLabel = (channel.peerDisplayName || channel.peerName || channel.name).trim();
    return peerLabel ? `@${peerLabel}` : null;
  }
  const channelName = channel.name.trim();
  return channelName ? `#${channelName}` : null;
}

function EnvironmentDevOverlay() {
  const previewApiTarget = usePreviewApiTarget(deploymentEnv === "web-preview");
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const { formatMessage } = useIntl();
  if (!environmentLabelMessageId) return null;
  if (isSlockdev && import.meta.env?.VITE_SLOCKDEV_HIDE_PANEL === "1") return null;
  if (hidden) return null;
  const environmentLabel = formatMessage({ id: environmentLabelMessageId });
  const previewEnvironmentDetails = getPreviewEnvironmentDetails(
    {
      branch: import.meta.env?.VITE_PREVIEW_BRANCH,
      commitSha: import.meta.env?.VITE_COMMIT_SHA,
      apiTarget: previewApiTarget,
    },
    formatMessage,
  );
  const badgeLabel = `${environmentLabel}${previewEnvironmentDetails ? ` · ${previewEnvironmentDetails}` : ""}`;
  const triggerTitle = formatMessage(
    { id: isSlockdev ? "devTools.overlay.triggerTitle" : "env.badge.dragTitle" },
    { label: badgeLabel },
  );
  const hideAllDevTools = () => {
    document.documentElement.dataset.raftDevToolsHidden = "true";
    window.dispatchEvent(new Event(HIDE_LOCAL_DEV_TOOLS_EVENT));
    setOpen(false);
    setHidden(true);
  };

  return (
    <DraggableDevOverlay
      id="environment-dev-tools"
      handleSelector="[data-dev-overlay-handle]"
      panel={isSlockdev && open ? (
        <SlockdevDebugPanel
          onClose={() => setOpen(false)}
          onHideAll={hideAllDevTools}
        />
      ) : null}
      open={open}
      onOpenChange={setOpen}
      collapsible
      collapsedChildren={(
        <Button
          type="button"
          variant="primary"
          size="icon-sm"
          aria-hidden="true"
          data-dev-overlay-handle
          className="flex size-6 touch-none select-none items-center justify-center border border-line-strong text-sm leading-none shadow-raft-sm theme-brutal:border-black theme-brutal:bg-soft-signal theme-brutal:text-black theme-brutal:shadow-brutal-sm cursor-grab active:cursor-grabbing"
        >
          <Settings2 size={12} strokeWidth={2.5} />
        </Button>
      )}
      className="fixed z-40 w-max max-w-[calc(100vw-1rem)] font-display"
      title={triggerTitle}
      testId="raftdev-debug-overlay"
    >
      <Button
        type="button"
        variant="primary"
        size="icon-sm"
        data-dev-overlay-handle
        onClick={isSlockdev ? () => setOpen((value) => !value) : undefined}
        aria-label={triggerTitle}
        className={`size-7 touch-none select-none border border-line-strong shadow-raft-sm theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-soft-signal theme-brutal:text-black theme-brutal:shadow-brutal-sm cursor-grab active:cursor-grabbing`}
        data-testid="raftdev-debug-trigger"
      >
        <Settings2 size={14} strokeWidth={2.5} aria-hidden="true" />
      </Button>
    </DraggableDevOverlay>
  );
}

interface SlockdevDebugPanelProps {
  onClose: () => void;
  onHideAll: () => void;
}

function SlockdevDebugPanel(props: SlockdevDebugPanelProps) {
  const { onClose, onHideAll } = props;
  const [copied, setCopied] = useState(false);
  const { formatMessage } = useIntl();
  const login = useAuthStore((s) => s.login);
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);
  const loading = useAuthStore((s) => s.loading);
  const envName = import.meta.env?.VITE_SLOCKDEV_ENV_NAME || "";
  const previewDescription = import.meta.env?.VITE_SLOCKDEV_PREVIEW_DESCRIPTION?.trim() || "";
  const seedCommand = getSlockdevSeedCommand(envName);
  if (!isSlockdev) return null;
  if (import.meta.env?.VITE_SLOCKDEV_HIDE_PANEL === "1") return null;

  const clearLocalState = () => {
    emitAuthTraceAndFlush("slock.auth.session_cleared", {
      clearSessionCaller: "clearLocalState",
      logoutTrigger: "dev_clear_local_state",
    });
    localStorage.removeItem("slock_access_token");
    localStorage.removeItem("slock_refresh_token");
    serverPersistence.clearLastServerSlug();
    localStorage.removeItem(PENDING_INVITE_STORAGE_KEY);
    window.location.assign("/");
  };

  const copySeedCommand = async () => {
    try {
      await navigator.clipboard.writeText(seedCommand);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (err) {
      console.warn("Failed to copy raftdev seed command", err);
    }
  };

  return (
    <div className="w-72 max-w-[calc(100vw-1rem)] overflow-y-auto bg-layer-panel p-3 text-xs text-foreground-strong shadow-raft-sm theme-brutal:bg-white theme-brutal:shadow-brutal">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-bold uppercase tracking-widest text-foreground-strong">
                {formatMessage({ id: "devTools.overlay.panelTitle" })}
              </div>
              <div className="mt-0.5 text-foreground-muted">
                <div className="truncate">{envName || "slockdev"}</div>
                <div className="truncate">
                  {user ? <SignedInAs user={user} nameClassName="font-normal" /> : "Not signed in"}
                </div>
              </div>
            </div>
            <Button
              type="button"
              onClick={onClose}
              size="icon-xs"
              variant="ghost"
              aria-label={formatMessage({ id: "common.close" })}
              data-testid="raftdev-debug-close"
              className="size-6 shrink-0 self-start"
            >
              <X size={14} aria-hidden="true" />
            </Button>
          </div>

          {previewDescription ? (
            <Tooltip content={previewDescription}>
              <details className="mb-2 rounded-md border border-line-muted bg-primary-soft p-2 theme-brutal:rounded-none theme-brutal:bg-soft-signal/20">
                <summary className="cursor-pointer select-none text-[10px] font-bold uppercase tracking-widest text-foreground-muted">
                  Preview description
                </summary>
                <p className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-foreground-muted">
                  {previewDescription}
                </p>
              </details>
            </Tooltip>
          ) : null}

          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              disabled={loading}
              onClick={() => login(SLOCKDEV_EMAIL, SLOCKDEV_PASSWORD).catch((err) => {
                console.error("Dev login failed", err);
              })}
              variant="accent"
              size="sm"
              className="w-full min-w-0"
            >
              Dev login
            </Button>
            <Button
              type="button"
              onClick={() => window.location.reload()}
              variant="outline"
              size="sm"
              className="w-full min-w-0"
            >
              Reload
            </Button>
            <Button
              type="button"
              onClick={() => {
                requestServerSelection();
                serverPersistence.clearLastServerSlug();
                window.location.assign("/");
              }}
              variant="outline"
              size="sm"
              className="w-full min-w-0"
            >
              Server Picker
            </Button>
            <Button
              type="button"
              onClick={() => logout()}
              variant="outline"
              size="sm"
              className="w-full min-w-0"
            >
              Log out
            </Button>
            <Button
              type="button"
              onClick={clearLocalState}
              variant="warning"
              size="sm"
              className="col-span-2 w-full"
            >
              Clear Local Session
            </Button>
            <Button
              type="button"
              onClick={copySeedCommand}
              variant="primary"
              size="sm"
              className="col-span-2 h-auto min-h-8 w-full justify-start whitespace-normal break-all text-left font-mono text-[11px]"
            >
              {copied ? "Copied" : seedCommand}
            </Button>
            <Button
              type="button"
              onClick={onHideAll}
              variant="outline"
              size="sm"
              className="col-span-2 h-auto min-h-8 w-full justify-start whitespace-normal text-left text-[10px]"
            >
              {formatMessage({ id: "devTools.overlay.hideUntilReload" })}
            </Button>
          </div>

        </div>
  );
}

/** Resolves server from URL slug and renders MainLayout */
export function ServerAccessDeniedPage() {
  const { formatMessage } = useIntl();
  const servers = useServerStore((s) => s.servers);
  const current = useServerStore((s) => s.current);
  const navigate = useNavigate();
  const lastSlug = serverPersistence.readLastServerSlug();
  const fallbackServer =
    (current ? servers.find((server) => server.id === current.id) : null) ??
    (lastSlug ? servers.find((server) => server.slug === lastSlug) : null) ??
    servers[0] ??
    null;
  const fallbackPath = fallbackServer
    ? (readServerSurfaceMemory(fallbackServer.slug) ?? `/s/${fallbackServer.slug}`)
    : "/";

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      navigate(fallbackPath, { replace: true });
    }, 3000);
    return () => window.clearTimeout(timeout);
  }, [fallbackPath, navigate]);

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-layer-canvas px-4 font-display safe-top safe-bottom theme-brutal:bg-brutal-cream">
      <Card className="w-full max-w-md border border-line-muted bg-layer-panel p-6 shadow-raft-md theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white theme-brutal:shadow-brutal">
        <h1 className="text-2xl font-black text-foreground-strong theme-brutal:text-black">{formatMessage({ id: "pages.serverNotFound.title" })}</h1>
        <p className="mt-3 text-sm leading-6 text-foreground-muted theme-brutal:text-black/70">
          {fallbackServer
            ? formatMessage(
                { id: "pages.serverNotFound.redirectingToServer" },
                { name: () => <strong key="server-name">{fallbackServer.name}</strong> },
              )
            : formatMessage({ id: "pages.serverNotFound.redirectingToList" })}
        </p>
        <div className="mt-5">
          <Button
            variant="outline"
            size="md"
            type="button"
            onClick={() => navigate(fallbackPath, { replace: true })}
            className="font-bold"
          >
            {fallbackServer
              ? formatMessage({ id: "pages.serverNotFound.goToMyServer" })
              : formatMessage({ id: "pages.serverNotFound.chooseServer" })}
          </Button>
        </div>
      </Card>
    </div>
  );
}

export function ServerResolver() {
  const { formatMessage } = useIntl();
  const { serverSlug } = useParams<{ serverSlug: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const appNav = useAppNavigate();
  const servers = useServerStore((s) => s.servers);
  const current = useServerStore((s) => s.current);
  const setCurrent = useServerStore((s) => s.setCurrent);
  const loading = useServerStore((s) => s.loading);
  const server = serverSlug ? servers.find((s) => s.slug === serverSlug) : undefined;
  const routeAgentId = serverSlug ? serverRouteAgentId(location.pathname, serverSlug) : null;
  const routeMachineId = serverSlug ? serverRouteMachineId(location.pathname, serverSlug) : null;
  const routeChannelId = serverSlug ? serverRouteChannelId(location.pathname, serverSlug) : null;
  const routeDmId = serverSlug ? serverRouteDmId(location.pathname, serverSlug) : null;
  const openThreadParentMessageId = useThreadStore((s) => s.openParentMessageId);
  const openThreadParentChannelId = useThreadStore((s) => s.openParentChannelId);
  const routeAgent = useAgentStore((state) =>
    routeAgentId ? state.agents.find((agent) => agent.id === routeAgentId) : undefined
  );
  const routeMachine = useMachineStore((state) =>
    routeMachineId ? state.machines.find((machine) => machine.id === routeMachineId) : undefined
  );
  const routeChannelTitleLabel = useChannelStore((state) => {
    const scopedChannelId = routeChannelId ?? routeDmId;
    if (!scopedChannelId) return null;
    return documentTitleChannelLabel(
      state.channels.find((channel) => channel.id === scopedChannelId)
      ?? state.dmChannels.find((channel) => channel.id === scopedChannelId),
    );
  });
  const threadChannelTitleLabel = useChannelStore((state) => {
    if (!openThreadParentMessageId || !openThreadParentChannelId) return null;
    return documentTitleChannelLabel(
      state.channels.find((channel) => channel.id === openThreadParentChannelId)
      ?? state.dmChannels.find((channel) => channel.id === openThreadParentChannelId),
    );
  });
  const missingCommunitySlug = routeCommunitySlug(server ? undefined : serverSlug);
  const directCommunityRouteIntentRef = useRef<CommunityServerSlug | null>(null);
  const communityAutoJoinAttemptedRef = useRef<string | null>(null);
  const communityJoinFlow = useJoinCommunityFlow({
    onJoined: (joinedServer) => {
      setCurrent(joinedServer);
    },
    onError: (error, slug, message) => {
      communityAutoJoinAttemptedRef.current = null;
      console.error(`[Community] Failed to join ${slug} from direct route: ${message}`, error);
    },
  });
  const jointInviteId = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get("jointInvite");
  }, [location.search]);
  const jointInviteAcceptingRef = useRef<string | null>(null);
  const [showServerSelector, setShowServerSelector] = useState(false);
  const routeServerName = server?.name;
  const routeServerSlug = server?.slug;
  const hostShell = isHostShell();
  const titleFallbacks = useMemo(() => ({
    agent: formatMessage({ id: "title.agentFallback" }),
    computer: formatMessage({ id: "title.computerFallback" }),
    computers: formatMessage({ id: "title.computers" }),
  }), [formatMessage]);
  const routeDocumentTitle = useMemo(
    () =>
      routeServerName !== undefined && routeServerSlug
        ? getServerRouteDocumentTitle(
            location.pathname,
            { name: routeServerName, slug: routeServerSlug },
            {
              agentLabel: routeAgent?.displayName || routeAgent?.name,
              machineLabel: routeMachine?.name,
              channelLabel: routeChannelTitleLabel,
              threadChannelLabel: threadChannelTitleLabel,
            },
            hostShell,
            titleFallbacks,
          )
        : hostShell
          ? hostShellFallbackDocumentTitle(titleFallbacks)
          : genericAppDocumentTitle(),
    [hostShell, location.pathname, routeAgent?.displayName, routeAgent?.name, routeChannelTitleLabel, routeMachine?.name, routeServerName, routeServerSlug, threadChannelTitleLabel, titleFallbacks],
  );

  useEffect(() => {
    if (loading || server) return;
    if (consumeServerSelectionRequest()) {
      directCommunityRouteIntentRef.current = null;
      setShowServerSelector(true);
      navigate("/", { replace: true });
      return;
    }
    if (missingCommunitySlug === CHINESE_COMMUNITY_SERVER_SLUG) {
      directCommunityRouteIntentRef.current = null;
      navigate(`${CHINESE_COMMUNITY_PAGE_PATH}?from=direct-community-route`, { replace: true });
      return;
    }
    if (missingCommunitySlug) {
      directCommunityRouteIntentRef.current = missingCommunitySlug;
    } else {
      directCommunityRouteIntentRef.current = null;
    }
  }, [loading, missingCommunitySlug, navigate, server]);

  useEffect(() => {
    if (loading || server || !missingCommunitySlug) return;
    if (directCommunityRouteIntentRef.current !== missingCommunitySlug) return;
    if (communityAutoJoinAttemptedRef.current === missingCommunitySlug) return;
    communityAutoJoinAttemptedRef.current = missingCommunitySlug;
    void communityJoinFlow.joinCommunity(missingCommunitySlug).then((outcome) => {
      if (outcome.status === "error") {
        communityAutoJoinAttemptedRef.current = null;
      }
    });
  }, [communityJoinFlow, loading, missingCommunitySlug, server]);

  useEffect(() => {
    if (server && directCommunityRouteIntentRef.current === server.slug) {
      directCommunityRouteIntentRef.current = null;
    }
  }, [server]);

  useEffect(() => {
    if (loading || !serverSlug) return;
    if (server && server.id !== current?.id) {
      setCurrent(server);
    }
  }, [serverSlug, server, loading, current?.id, setCurrent]);

  useBrowserDocumentTitle(routeDocumentTitle);

  useEffect(() => {
    if (!jointInviteId || !server || !current || current.id !== server.id) return;
    if (jointInviteAcceptingRef.current === jointInviteId) return;

    jointInviteAcceptingRef.current = jointInviteId;
    api.post(`/channels/joint-invites/${encodeURIComponent(jointInviteId)}/accept`)
      .then(async ({ data }) => {
        const channelId = typeof data?.id === "string" ? data.id : null;
        if (channelId) {
          await useChannelStore.getState().ensureChannel(channelId);
          appNav.toChannel(channelId);
          return;
        }
        const params = new URLSearchParams(location.search);
        params.delete("jointInvite");
        const query = params.toString();
        navigate(`${location.pathname}${query ? `?${query}` : ""}`, { replace: true });
      })
      .catch((err) => {
        jointInviteAcceptingRef.current = null;
        console.error("Failed to accept joint channel invite", err);
        showToast({ title: jointInviteAcceptErrorMessage(err, formatMessage), type: "error" });
      });
  }, [appNav, current, formatMessage, jointInviteId, location.pathname, location.search, navigate, server]);

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-brutal-cream font-display safe-top">
        <div className="text-xl font-bold">{formatMessage({ id: "pages.app.loadingServers" })}</div>
      </div>
    );
  }

  if (!server) {
    if (missingCommunitySlug && communityJoinFlow.joiningCommunitySlug === missingCommunitySlug) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-brutal-cream font-display safe-top">
          <div className="text-xl font-bold">{formatMessage({ id: "pages.app.joiningCommunity" })}</div>
        </div>
      );
    }
    // Someone who owns NO servers has not been denied anything — they simply have not
    // made one yet. Sending them to "server not found" and then bouncing them to the
    // create-server screen showed an error for something they never did wrong, and made
    // logging back in mid-onboarding flash a denial before landing where they left off.
    // The first-server flow IS the right screen here, so render it directly.
    if (showServerSelector || servers.length === 0) {
      return (
        <ServerSelector
          onSelect={(nextServer) => {
            setCurrent(nextServer);
            navigate(readServerSurfaceMemory(nextServer.slug) ?? `/s/${nextServer.slug}`, {
              replace: true,
            });
          }}
        />
      );
    }
    return (
      <>
        <ServerAccessDeniedPage />
        {communityJoinFlow.agreementDialog}
      </>
    );
  }

  if (!current || current.id !== server.id) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-brutal-cream font-display safe-top">
        <div className="text-xl font-bold">{formatMessage({ id: "common.loading" })}</div>
      </div>
    );
  }

  // Standalone onboarding surface for CLIENT hosts only (Native WebView with a
  // wake generation). Renders only the server-authoritative setup gate — no
  // channel/sidebar/settings shell and no route-derived completion guess. The
  // browser flow renders the same gate as Modals inside MainLayout instead.
  // Authentication still goes through AppShell, and ServerResolver still proves
  // the slug belongs to the signed-in principal.
  // `key={server.id}` (same contract as MainLayout below): the gate's
  // projection state, wake once-refs, and connection-watch baselines are
  // per-server, and refreshProjection has no stale-response guard, so a
  // cross-server reuse would land server A's late projection read into
  // server B's surface. The `current.id !== server.id` guard above happens to
  // unmount the gate during a switch too, but that is update-timing, not a
  // stated contract — the key makes the isolation explicit.
  if (location.pathname === `/s/${server.slug}/onboarding`) {
    const generation = readNativeOnboardingGeneration(location.search);
    // Only clients enter the standalone surface (artin, #proj-mobile d89d3318):
    // the client always opens this URL with its wake generation. A plain browser
    // without one gets the Modal flow on the main surface instead.
    if (!generation) return <Navigate to={`/s/${server.slug}`} replace />;
    return (
      <main
        className="relative flex min-h-0 flex-1 bg-brutal-cream font-display safe-top safe-bottom"
        data-testid="native-onboarding-web-surface"
      >
        <ServerSetupProjectionGate
          key={server.id}
          serverId={server.id}
          serverSlug={server.slug}
          completionWakeGeneration={generation}
          dedicatedSurface
        />
      </main>
    );
  }

  // `/thread-window` is intentionally kept as a first-class route even though
  // the in-app "open in new tab" entry points (thread header / overflow menu,
  // task card, message context menu) were removed on 2026-09-10 by product
  // call. The route, its URL sync and the window components stay so the
  // standalone window can be re-exposed later without rebuilding the plumbing
  // — see utils/openPanelInNewTab.ts (builders, no UI callsites today).
  if (location.pathname === `/s/${server.slug}/thread-window`) {
    // Remount on a new deep-link identity so an async failure from a previous
    // popup target cannot bleed into the next thread/task opened in this tab.
    return <ThreadWindowRoute key={location.search} />;
  }

  return <MainLayout key={server.id} />;
}

export function ServerSelectionPage() {
  const { formatMessage } = useIntl();
  const setCurrent = useServerStore((s) => s.setCurrent);
  const loading = useServerStore((s) => s.loading);
  const navigate = useNavigate();

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-brutal-cream font-display safe-top">
        <div className="text-xl font-bold">{formatMessage({ id: "pages.app.loadingServers" })}</div>
      </div>
    );
  }

  return (
    <ServerSelector
      onSelect={(server) => {
        setCurrent(server);
        navigate(readServerSurfaceMemory(server.slug) ?? `/s/${server.slug}`);
      }}
    />
  );
}

/** Auto-redirect to last server, or show ServerSelector */
export function ServerRedirect() {
  const { formatMessage } = useIntl();
  const servers = useServerStore((s) => s.servers);
  const loading = useServerStore((s) => s.loading);
  const setCurrent = useServerStore((s) => s.setCurrent);
  const navigate = useNavigate();
  const [showServerSelector] = useState(() => consumeServerSelectionRequest());
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-brutal-cream font-display safe-top">
        <div className="text-xl font-bold">{formatMessage({ id: "pages.app.loadingServers" })}</div>
      </div>
    );
  }

  // A deliberate Server Picker action must win over normal last-server and
  // deep-location restoration, including on a cold navigation to "/".
  if (showServerSelector) {
    return (
      <ServerSelector
        onSelect={(server) => {
          setCurrent(server);
          navigate(readServerSurfaceMemory(server.slug) ?? `/s/${server.slug}`, { replace: true });
        }}
      />
    );
  }

  const nativeTarget = getDesktopServerBootstrapTarget(location.search, servers);
  if (nativeTarget) {
    return <Navigate to={nativeTarget} replace />;
  }

  // `/.well-known/change-password` redirects here before auth is known. The
  // pathname survives the signed-out login screen, so once auth + the server
  // list are restored this same resolver can choose the browser's remembered
  // server without inventing an account-global settings surface.
  const changePasswordIntent = isChangePasswordIntentPath(location.pathname);

  // Auto-redirect to last used server
  const lastSlug = serverPersistence.readLastServerSlug();
  const lastServer = lastSlug ? servers.find((s) => s.slug === lastSlug) : null;
  if (lastServer) {
    return (
      <Navigate
        to={serverEntryPath({
          serverSlug: lastServer.slug,
          rememberedSurface: readServerSurfaceMemory(lastServer.slug),
          changePasswordIntent,
        })}
        replace
      />
    );
  }

  // No last server — show selector (user picks or creates)
  return (
    <ServerSelector
      onSelect={(server) => {
        setCurrent(server);
        // replace, like every other root → server hop: the picker at "/" only
        // exists while no last server is remembered, so a history Back onto it
        // would just re-run ServerRedirect and bounce forward again.
        navigate(serverEntryPath({
          serverSlug: server.slug,
          rememberedSurface: readServerSurfaceMemory(server.slug),
          changePasswordIntent,
        }), { replace: true });
      }}
    />
  );
}

// Standalone palette audit page (#proj-uiux:0e6befb8 task #92).
// Bypasses auth + MainLayout so it can scroll freely (the normal
// shell pins #root with overflow:hidden which fights long pages).
// Routed at the App boundary so the auth/data hooks below run inside
// AppShell and are never conditionally skipped — earlier the early-return
// gated `window.location.pathname === "/palette-audit"` made every hook in
// AppShell rules-of-hooks-conditional under SPA nav.
/** Auth bootstrap loading / restoring chrome — exported for zh-cn i18n behavior tests. */
export function AuthBootstrapStatus({ view }: { view: "loading" | "restoring" }) {
  const { formatMessage } = useIntl();
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-brutal-cream font-display safe-top">
      <div className="text-xl font-bold">
        {view === "restoring"
          ? formatMessage({ id: "auth.bootstrap.restoringSession" })
          : formatMessage({ id: "common.loading" })}
      </div>
    </div>
  );
}

export function AppShell() {
  const { formatMessage } = useIntl();
  const user = useAuthStore((s) => s.user);
  const accessToken = useAuthStore((s) => s.accessToken);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const initialized = useAuthStore((s) => s.initialized);
  const restoreState = useAuthStore((s) => s.restoreState);
  const login = useAuthStore((s) => s.login);
  const loadUser = useAuthStore((s) => s.loadUser);
  const logout = useAuthStore((s) => s.logout);

  const serverLoading = useServerStore((s) => s.loading);
  const servers = useServerStore((s) => s.servers);
  const loadServers = useServerStore((s) => s.loadServers);
  const setCurrentServer = useServerStore((s) => s.setCurrent);
  const navigate = useNavigate();
  const location = useLocation();

  const [authView, setAuthView] = useState<AuthView>("login");
  const [publicViewDismissed, setPublicViewDismissed] = useState(false);
  const [devAutoLoginAttempted, setDevAutoLoginAttempted] = useState(false);

  // Read URL params once on mount, but inviteToken is stateful so it can be cleared
  const urlParamsRef = useMemo(() => getUrlParams(), []);
  const [inviteToken, setInviteToken] = useState<string | null>(urlParamsRef.inviteToken);
  const urlParams = useMemo(() => ({ ...urlParamsRef, inviteToken }), [urlParamsRef, inviteToken]);

  // Load user on mount
  useEffect(() => {
    loadUser();
  }, [loadUser]);

  // Reconcile the UI display language to the signed-in user's server-persisted
  // preference once auth bootstrap settles (login / cold-load restore).
  // Missing/unsupported account values resolve English-first; explicit en or
  // zh-cn values win exactly. Waiting for an initialized, authenticated user
  // avoids overwriting a valid cached explicit choice while the account record
  // is in flight or after logout (signed-out state is not an account value).
  // Lives here (not in LocaleProvider) to keep the auth store out of the i18n
  // module graph.
  const { setLocaleFromUser } = useLocale();
  const authenticatedUserId = user?.id ?? null;
  const userDisplayLanguage = user?.displayLanguage ?? null;
  // Syncs an external source (auth store's server-persisted preference, which
  // arrives async on login/restore) INTO the locale context — not derived
  // render state, so an effect is correct here.
  // oxlint-disable-next-line react-doctor/no-derived-state-effect
  useEffect(() => {
    if (!shouldReconcileAccountLocale({ initialized, userId: authenticatedUserId })) return;
    setLocaleFromUser(userDisplayLanguage);
  }, [authenticatedUserId, initialized, userDisplayLanguage, setLocaleFromUser]);

  const hasStoredSession = !!(accessToken && refreshToken);
  const authBootstrapView = getAuthBootstrapView({ initialized, restoreState });
  const authRestoreStartedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!shouldAutoLoginSlockdev({
      deploymentEnv,
      initialized,
      attempted: devAutoLoginAttempted,
      hasUser: !!user,
      hasStoredSession,
      authView,
      authCallback: urlParams.authCallback,
      resetToken: urlParams.resetToken,
      inviteToken: urlParams.inviteToken,
    })) {
      return;
    }

    // oxlint-disable-next-line react-doctor/no-chain-state-updates -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    setDevAutoLoginAttempted(true);
    login(SLOCKDEV_EMAIL, SLOCKDEV_PASSWORD).catch((err) => {
      console.warn("Slockdev auto-login failed", err);
    });
  }, [
    initialized,
    devAutoLoginAttempted,
    user,
    hasStoredSession,
    authView,
    urlParams.authCallback,
    urlParams.resetToken,
    urlParams.inviteToken,
    login,
  ]);

  // Mobile browsers can transiently fail /auth/me during foreground restore.
  // Keep retrying session restoration while credentials still exist so the UI
  // doesn't bounce back to the login screen during a recoverable outage.
  //
  // Restore timeout policy (Auth Session Contract, #2494 / restoreTimeoutPolicy
  // #2497): a timer alone is TRANSIENT evidence and must never sign a user out
  // who still has a stored session. All three timer-only branches below
  // (initial check, retry-interval check, setTimeout fallback) route through
  // `getRestoreTimeoutAction()`: only `"logout"` calls `logout()`; the
  // stored-session timeout case returns `"degraded_retry"` so retry continues
  // without clearing the token. Terminal logout is the loadUser /
  // getAuthVerdict path's authority alone.
  useEffect(() => {
    if (!shouldRetryAuthRestore({ initialized, restoreState, hasStoredSession })) {
      authRestoreStartedAtRef.current = null;
      return;
    }

    if (authRestoreStartedAtRef.current === null) {
      authRestoreStartedAtRef.current = Date.now();
    }

    const elapsedMs = Date.now() - authRestoreStartedAtRef.current;
    const initialAction = getRestoreTimeoutAction({ initialized, restoreState, hasStoredSession, elapsedMs });
    if (initialAction === "logout") {
      logout("restore_timeout");
      return;
    }

    const retryInterval = window.setInterval(() => {
      const retryElapsedMs = authRestoreStartedAtRef.current === null
        ? 0
        : Date.now() - authRestoreStartedAtRef.current;
      const retryAction = getRestoreTimeoutAction({ initialized, restoreState, hasStoredSession, elapsedMs: retryElapsedMs });
      if (retryAction === "logout") {
        logout("restore_timeout");
        return;
      }
      loadUser();
    }, 1500);
    const timeout = window.setTimeout(() => {
      const timeoutElapsedMs = authRestoreStartedAtRef.current === null
        ? MAX_AUTH_RESTORE_MS
        : Date.now() - authRestoreStartedAtRef.current;
      const timeoutAction = getRestoreTimeoutAction({ initialized, restoreState, hasStoredSession, elapsedMs: timeoutElapsedMs });
      if (timeoutAction === "logout") {
        logout("restore_timeout");
      }
    }, Math.max(0, MAX_AUTH_RESTORE_MS - elapsedMs));
    return () => {
      window.clearInterval(retryInterval);
      window.clearTimeout(timeout);
    };
  }, [initialized, restoreState, hasStoredSession, loadUser, logout]);

  useEffect(() => {
    const handleRecoverySignal = () => {
      if (
        shouldRecoverAuthOnBrowserSignal({
          visible: document.visibilityState === "visible",
          online: navigator.onLine,
          initialized,
          restoreState,
          hasStoredSession,
        })
      ) {
        loadUser();
      }
    };

    window.addEventListener("online", handleRecoverySignal);
    document.addEventListener("visibilitychange", handleRecoverySignal);
    return () => {
      window.removeEventListener("online", handleRecoverySignal);
      document.removeEventListener("visibilitychange", handleRecoverySignal);
    };
  }, [initialized, restoreState, hasStoredSession, loadUser]);

  const profileSetupRequired = requiresAccountProfileSetup(user);
  // Any `/s/<slug>/...` link can open the public read-only page for a
  // nonmember; a `/channel/<id>` deep link preselects that public channel.
  const publicServerRoute = location.pathname.match(/^\/s\/([^/]+)(?:\/channel\/([^/]+))?(?:\/.*)?$/);
  let publicServerSlug: string | null = null;
  let publicChannelId: string | null = null;
  if (publicServerRoute) {
    try {
      publicServerSlug = decodeURIComponent(publicServerRoute[1]!);
      publicChannelId = publicServerRoute[2] ? decodeURIComponent(publicServerRoute[2]) : null;
    } catch {
      publicServerSlug = null;
      publicChannelId = null;
    }
  }

  // Signing in from a public server temporarily dismisses the public page so
  // the login form can render at the same URL. Once identity arrives, restore
  // that page for a nonmember instead of treating the session as membership.
  // oxlint-disable-next-line react-doctor/no-derived-state-effect
  useEffect(() => {
    if (authenticatedUserId && publicServerSlug) setPublicViewDismissed(false);
  }, [authenticatedUserId, publicServerSlug]);

  // Identity setup is account-global and must complete before any server data
  // or pending invite side effects are loaded.
  useEffect(() => {
    if (user && !profileSetupRequired) {
      loadServers();
    }
  }, [user, profileSetupRequired, loadServers]);

  // Single boot entry for the cross-server unread summary. Components keep
  // only their event/interval triggers (LeftRail: prefs + local-unread edge;
  // Sidebar: interval/focus/visibility/prefs/eager edge) — previously each
  // mount issued its own boot fetch (the unread-summary boot wave).
  const serversCount = useServerStore((s) => s.servers.length);
  const loadServerUnreadSummary = useServerStore((s) => s.loadServerUnreadSummary);
  useEffect(() => {
    if (!user || serversCount === 0) return;
    void loadServerUnreadSummary();
  }, [user, serversCount, loadServerUnreadSummary]);

  // Precise PWA resume: restore the last deep location on cold start from `/`.
  // Only active once the user is authenticated and there's no pending invite,
  // so it doesn't fight with login / email-verification / invite redirects.
  const hasPendingInvite = !!localStorage.getItem(PENDING_INVITE_STORAGE_KEY);
  const canResumeLocation = !!user
    && user.emailVerified
    && !profileSetupRequired
    && !urlParams.inviteToken
    && !urlParams.resetToken
    && !hasPendingInvite
    && !serverLoading
    && !isServerSelectionRequested();
  useLastLocationResume(canResumeLocation);

  // Resume pending invite from localStorage (set during invite flow → login/register)
  // through the invite page, so login completion never mutates membership by
  // itself.
  useEffect(() => {
    if (!user || !user.emailVerified || profileSetupRequired) return;
    // While a reset link is active, do NOT consume the pending invite or navigate
    // to /?invite=… — that would clobber the ?reset token (breaking refresh) and
    // burn the invite record. Leave it in storage untouched: when the reset is
    // done, onBack reloads the app, and that fresh mount (URL no longer carrying
    // ?reset) runs this effect and resumes the still-stored invite. Read resetToken
    // off urlParamsRef (the mount-frozen useMemo([]) source), not urlParams: the
    // resolved resetToken string is constant either way (so behavior is identical),
    // but urlParams derives from inviteToken — which this effect sets — so
    // oxlint react-doctor/no-chain-state-updates statically rejects listing
    // urlParams.resetToken as a dep. Depending on the mount-frozen ref avoids that
    // while keeping exhaustive-deps satisfied.
    if (urlParamsRef.resetToken) return;
    const pendingInviteRedirect = takePendingInviteRedirectPath();
    if (!pendingInviteRedirect) return;

    const pendingInvite = new URLSearchParams(pendingInviteRedirect.split("?")[1] ?? "").get("invite");
    if (!pendingInvite) return;

    setInviteToken(pendingInvite);
    navigate(pendingInviteRedirect, { replace: true });
  }, [user, profileSetupRequired, urlParamsRef, navigate]);

  // Determine page content
  let content: React.ReactNode;

  if (urlParams.authCallback === "social") {
    content = <SocialAuthCallbackPage />;
  } else if (authBootstrapView === "loading" || authBootstrapView === "restoring") {
    content = <AuthBootstrapStatus view={authBootstrapView} />;
  } else if (urlParams.resetToken) {
    // A reset link must work even when a session is already active (e.g. an
    // OAuth-created account setting its first password is, by definition, logged
    // in). The page only calls resetPassword(token, …), which resets the TOKEN's
    // owner server-side and never touches the current session — so a logged-in A
    // opening B's link resets B without mutating A. Checked before every other
    // branch so a reset token wins if it coexists with invite/verify params.
    content = (
      <ResetPasswordPage
        token={urlParams.resetToken}
        onBack={() => {
          const url = new URL(window.location.href);
          url.searchParams.delete("reset");
          // Keep url.search: drop ONLY reset, preserve any invite/verify/other
          // params so the post-reset reload can still resume those flows.
          window.history.replaceState({}, "", url.pathname + url.search + url.hash);
          // Logged-out → return to sign-in; logged-in → reload keeps the current
          // session and lands back in the app (never an implicit logout/switch).
          if (!user) setAuthView("login");
          window.location.reload();
        }}
      />
    );
  } else if (!user) {
    if (urlParams.inviteToken) {
      content = (
        <InviteAcceptPage
          token={urlParams.inviteToken}
          onInviteConsumed={() => setInviteToken(null)}
          onSwitchToLogin={() => {
            setInviteToken(null);
            setAuthView("login");
          }}
          onSwitchToRegister={() => {
            setInviteToken(null);
            setAuthView("register");
          }}
        />
      );
    } else if (publicServerSlug && !publicViewDismissed) {
      content = (
        <PublicServerPage
          slug={publicServerSlug}
          initialChannelId={publicChannelId}
          onSignIn={() => {
            setPublicViewDismissed(true);
            setAuthView("login");
          }}
          onRegister={() => {
            setPublicViewDismissed(true);
            setAuthView("register");
          }}
          onUnavailable={() => setPublicViewDismissed(true)}
        />
      );
    } else if (authView === "register") {
      content = <RegisterPage onSwitchToLogin={() => setAuthView("login")} />;
    } else if (authView === "forgot-password") {
      content = <ForgotPasswordPage onBack={() => setAuthView("login")} />;
    } else {
      content = (
        <LoginPage
          onSwitchToRegister={() => setAuthView("register")}
          onForgotPassword={() => setAuthView("forgot-password")}
        />
      );
    }
  } else if (urlParams.inviteToken) {
    content = (
      <InviteAcceptPage
        token={urlParams.inviteToken}
        onInviteConsumed={() => setInviteToken(null)}
        onSwitchToLogin={() => {}}
        onSwitchToRegister={() => {}}
      />
    );
  } else if (!user.emailVerified) {
    content = <EmailVerificationPage initialToken={urlParams.verifyToken} />;
  } else if (profileSetupRequired) {
    content = <AccountIdentitySetupPage />;
  } else if (serverLoading) {
    content = (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-brutal-cream font-display safe-top">
        <div className="text-xl font-bold">{formatMessage({ id: "pages.app.loadingServers" })}</div>
      </div>
    );
  } else if (publicServerSlug && !publicViewDismissed && !servers.some((server) => server.slug === publicServerSlug)) {
    content = (
      <PublicServerPage
        slug={publicServerSlug}
        initialChannelId={publicChannelId}
        authenticated
        onSignIn={() => {}}
        onRegister={() => {}}
        onUnavailable={() => setPublicViewDismissed(true)}
        onJoined={async () => {
          await loadServers();
          const joined = useServerStore.getState().servers.find((server) => server.slug === publicServerSlug);
          if (!joined) throw new Error("Joined server was not returned by the server list");
          setCurrentServer(joined);
          navigate(publicChannelId ? `/s/${joined.slug}/channel/${encodeURIComponent(publicChannelId)}` : `/s/${joined.slug}`, { replace: true });
        }}
      />
    );
  } else {
    // Authenticated + servers loaded → URL-based server routing
    content = (
      <Routes>
        <Route path="/login-with-raft/setup" element={<HumanLoginSetupPage />} />
        <Route path="/login-with-slock/setup" element={<HumanLoginSetupPage />} />
        <Route path="/login-with-slock-human/setup" element={<HumanLoginSetupPage />} />
        <Route path="/login/device" element={<DeviceLoginPage />} />
        <Route path="/login/app" element={<AppLoginPage />} />
        <Route path={INTEGRATION_INVITE_ROUTE} element={<IntegrationInvitePage />} />
        <Route path="/connections/callback" element={<AgentConnectionCallbackPage />} />
        <Route path="/servers" element={<ServerSelectionPage />} />
        <Route path="/s/:serverSlug/*" element={<ServerResolver />} />
        <Route path="*" element={<ServerRedirect />} />
      </Routes>
    );
  }

  return (
    <>
      <NavigationDepthTracker />
      <EnvironmentDevOverlay />
      {content}
      <MessageSelectionShortcut />
      <ImageLightbox />
      <DocumentPreviewHost />
      <MediaPreviewHost />
    </>
  );
}

export function PaletteAuditRoute({ isDev = import.meta.env.DEV }: { isDev?: boolean }) {
  return isDev ? <PaletteAuditPage /> : <Navigate to="/" replace />;
}

function App() {
  return (
    <Routes>
      <Route
        path="/palette-audit"
        element={<PaletteAuditRoute />}
      />
      <Route
        path="/dev/account-bootstrap"
        element={import.meta.env.DEV ? <AccountBootstrapPreviewPage /> : <Navigate to="/" replace />}
      />
      <Route
        path="/dev/server-setup"
        element={import.meta.env.DEV ? <ServerSetupComputerRuntimePreviewPage /> : <Navigate to="/" replace />}
      />
      {/* Public utility routes must render outside the authenticated shell.
          Place them before the catch-all, which would otherwise swallow them
          into AppShell. */}
      <Route path="/download" element={<MobileDownloadChooserPage />} />
      <Route path={CHINESE_COMMUNITY_PAGE_PATH} element={<ChineseCommunityPage />} />
      <Route path="/*" element={<AppShell />} />
    </Routes>
  );
}

export default App;
