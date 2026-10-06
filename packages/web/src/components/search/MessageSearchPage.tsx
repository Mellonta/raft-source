import { getEffectiveLimits } from "@botiverse/raft-shared";
import type { ServerPlan } from "@botiverse/raft-shared";
import { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { ArrowDownUp, AtSign, CalendarRange, ChevronDown, Clock3, FolderOpen, Hash, Monitor, Search, Star, UserCircle2, X } from "lucide-react";
import {
  Badge,
  Button,
  Combobox,
  ComboboxClear,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxHeader,
  ComboboxInput,
  ComboboxInputGroup,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxLabel,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
  ComboboxTriggerIndicator,
  ContextMenuPopup,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Kbd,
  PickerTriggerButton,
  SearchEntityResult,
  SearchEntityResultContent,
  SearchEntityResultDescription,
  SearchEntityResultHeader,
  SearchEntityResultIcon,
  SearchEntityResultLeading,
  SearchEntityResultTitle,
  SearchMessageResult,
  SearchMessageResultBody,
  SearchMessageResultHeader,
  SearchMessageResultMatch,
  SearchMessageResultMeta,
  SearchMessageResultSender,
  SearchMessageResultThreadMeta,
  SearchMessageResultTimestamp,
  SearchResultsList,
  SearchResultsSection,
  SearchResultsSectionHeading,
  SearchResultsSummary,
  SearchShellFilters,
  SearchShellRoot,
  SearchShellViewport,
  SearchThreadMessageResult,
  SearchThreadResult,
  SearchThreadResultHeader,
  SearchThreadResultMessages,
  SearchThreadResultMeta,
  SearchThreadResultTimestamp,
  SearchThreadResultTitle,
  Select,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectSeparator,
  SelectTrigger,
  ThreadIcon,
} from "raft-ui";
import { useLocation, useNavigate } from "react-router-dom";
import api from "../../api/client";
import { useAuthStore } from "../../store/authStore";
import { formatRelativeTimeParts } from "../../utils/relativeTime";
import { useServerStore } from "../../store/serverStore";
import { useChannelStore } from "../../store/channelStore";
import { useAgentStore } from "../../store/agentStore";
import { useMachineStore } from "../../store/machineStore";
import { useThreadStore } from "../../store/threadStore";
import { useSearchContentStore } from "../../store/searchContentStore";
import {
  getSearchEntityUsageScopeKey,
  useSearchEntityUsageStore,
} from "../../store/searchEntityUsageStore";
import { conversationChannelIdFromPath } from "./recentConversations";
import { useRecentConversationEntities, useSearchEntityCatalog } from "./useRecentConversationEntities";
import { useAppNavigate, useMobileBack } from "../../hooks/useAppNavigate";
import { useLiveSearchParams } from "../../hooks/useLiveSearchParams";
import AgentActivityDot from "../agent/AgentActivityDot";
import PanelHeader from "../ui/PanelHeader";
import Skeleton from "../ui/Skeleton";
import SectionEyebrow from "../ui/SectionEyebrow";
import AvatarSlot from "../ui/AvatarSlot";
import DismissBackdrop from "../ui/DismissBackdrop";
import MenuItem from "../ui/MenuItem";
import {
  ARCHIVED_CHANNEL_BADGE_CLASS,
  ARCHIVED_CHANNEL_ICON_CLASS,
  ARCHIVED_CHANNEL_MUTED_TEXT_CLASS,
  ARCHIVED_CHANNEL_TEXT_CLASS,
} from "../channel/channelArchiveVisual";
import { ChannelKindIcon } from "../channel/channelKindIcon";
import { resolveMessageSenderMemberFromList } from "../../utils/messageSenderMember";
import {
  buildTimeRangeParams,
  getSearchRelativeTimeParts,
  getEffectiveMessageSearchSort,
  groupMessageSearchResults,
  hasMeaningfulMessageSearchFilter,
  normalizeSearchScopes,
  normalizeSearchSort,
  normalizeSearchTimeRange,
} from "./searchGrouping";
import type {
  SearchScope,
  SearchSort,
  SearchTimeRange,
} from "./searchGrouping";
import { getCommittedSearchQuery, isSearchKeyboardComposing } from "./searchComposition";
import { buildSearchRetryReset } from "./searchRetry";
import { SEARCH_FOCUS_REQUEST_EVENT } from "../../utils/searchFocusRequest";
import { getGlobalSearchShortcutLabel } from "../../utils/keyboardShortcuts";
import { useRankedComposerSuggestions } from "../../hooks/useRankedComposerSuggestions";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { placeContextMenu } from "../ui/contextMenuPosition";
import type { WorkspacePanelRef } from "../workspace/workspaceGridDemoConfig";
import {
  buildSearchEntityEntriesWhenQueryPresent,
  filterSearchEntityEntriesForQuery,
  findExactDestination,
} from "./searchEntities";
import type {
  SearchEntityResult as SearchEntityRecord,
  SearchEntitySubtitle,
} from "./searchEntities";
import {
  addSearchHistoryEntry,
  applySearchState,
  captureSearchState,
  getSearchEntityUsageStorageKey,
  getSearchHistoryStorageKey,
  getSearchStateStorageKey,
  persistSearchHistory,
  persistSearchState,
  readSearchEntityUsage,
  readSearchHistory,
  readSearchState,
  removeSearchHistoryEntry,
  resolveSearchHistoryEditing,
  shouldRenderSearchHistoryRemove,
  searchParamsHaveExplicitState,
  selectFrequentSearchEntities,
} from "./searchHome";
import { fullPageSearchHopState, resolveSearchOverlayBackground, SEARCH_PRESENTATION_PAGE, SEARCH_PRESENTATION_PARAM } from "./searchOverlayLocation";

// Server entities (channels, people, agents, machines) are a ranked list, not a
// preview: show every reasonable match and let the list scroll (≈5 rows tall,
// see ENTITY_RESULTS_SCROLL_CLASS) instead of silently dropping matches past 5.
const MAX_ENTITY_RESULTS = 50;
// ≈5.5 entity rows: the half row peeking at the bottom signals the list scrolls.
// The padding/negative margin pair keeps rui's selected ring and brutal shadow
// from being clipped by the scroll container.
const ENTITY_RESULTS_SCROLL_CLASS = "-m-1.5 max-h-[24rem] overflow-y-auto overscroll-contain p-1.5";
// Desktop ⌘K overlay (task #102, Slack model): the overlay is a suggestion layer,
// not the results page — it previews a handful of message hits and hands
// "everything" to the full results page through the "view all results" row.
const OVERLAY_MESSAGE_PREVIEW_LIMIT = 5;
const OVERLAY_ALL_RESULTS_KEY = "action:view-all-results";
// Return-key glyph for the overlay's "view all results" row (not translatable copy).
const RETURN_KEY_GLYPH = "↵";

type SelectableSearchResult =
  | { key: string; kind: "entity"; result: SearchEntityRecord }
  | { key: string; kind: "message"; result: MessageSearchResult }
  | { key: string; kind: "allResults" };

const OVERLAY_ALL_RESULTS_ROW: SelectableSearchResult = { key: OVERLAY_ALL_RESULTS_KEY, kind: "allResults" };

function isSelectableRow(row: SelectableSearchResult | null): row is SelectableSearchResult {
  return row !== null;
}
const PAGE_SIZE = 20;
const SEARCH_HOME_TOUCH_QUERY = "(max-width: 767px)";
const SEARCH_SCOPE_OPTIONS = ["mentioned", "humans", "agents"] as const satisfies readonly SearchScope[];
const SEARCH_TIME_RANGES = ["any", "today", "7d", "30d"] as const satisfies readonly SearchTimeRange[];
const SEARCH_SORTS = ["relevance", "recent"] as const satisfies readonly SearchSort[];
const EMPTY_SEARCH_ENTITY_USAGE = {};
type SearchFailureKind = "request_failed" | "query_too_broad" | "search_timeout";

function readSearchFailureCode(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== "object") return undefined;
  const data = (response as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const payload = data as { code?: unknown; errorCode?: unknown };
  return payload.code ?? payload.errorCode;
}

function classifySearchFailure(error: unknown): SearchFailureKind {
  const code = readSearchFailureCode(error);
  if (code === "QUERY_TOO_BROAD") return "query_too_broad";
  if (code === "SEARCH_TIMEOUT") return "search_timeout";
  return "request_failed";
}

// Module-level snapshot of the last successful search result set. MainLayout
// remounts MessageSearchPage when /search transitions from single-page (col-3
// host, slot=null) to master/detail (col-2 host, slot=open) — they are
// different positions in the tree, so React drops local state. Without this
// cache the new mount renders an empty list, fires a 200ms-debounced re-fetch,
// and only refills after the RTT — read as a flash + jump (stdrc msg=4b24a914
// 2026-05-28 "还是会闪"). Re-keying on the exact params (q + filters + sort)
// means the cache only short-circuits when the next mount asks for the same
// query; any different query falls through to the normal fetch path.
//
// The snapshot is also keyed by the server it was fetched from. MainLayout is
// keyed by server id, so a server switch remounts this page — but the module
// variable survives. Without the server key, re-opening search with the same
// query on another server would seed and short-circuit on the previous
// server's results; clicking one of those hits then resolves its ids against
// the *current* server's X-Server-Id and 404s (task #14: a thread hit opened
// an empty "No replies yet" panel).
interface SearchResultsSnapshot {
  serverId: string | null;
  paramsKey: string;
  query: string;
  results: MessageSearchResult[];
  hasMore: boolean;
}
let cachedSearchSnapshot: SearchResultsSnapshot | null = null;

function readSearchSnapshotForServer(serverId: string | null | undefined): SearchResultsSnapshot | null {
  return cachedSearchSnapshot && cachedSearchSnapshot.serverId === (serverId ?? null)
    ? cachedSearchSnapshot
    : null;
}

function serializeSearchParams(params: Record<string, string | number>): string {
  // Stable key — drop `offset` since the cache only covers the first page.
  const { offset: _offset, ...rest } = params;
  return Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("&");
}

// Return the message KEY (not a localized string) so the callsite formats with
// the active locale — no string-branching on translated text.
function getScopeOptionLabelId(scope: SearchScope): "search.scopeMe" | "search.scopeHumans" | "search.scopeAgents" {
  switch (scope) {
    case "mentioned":
      return "search.scopeMe";
    case "humans":
      return "search.scopeHumans";
    case "agents":
      return "search.scopeAgents";
  }
}

function getScopeChipLabel(scopes: readonly SearchScope[], formatMessage: IntlShape["formatMessage"]): string {
  return scopes.length > 0
    ? formatMessage({ id: "search.scopeChip" }, { count: scopes.length })
    : formatMessage({ id: "search.scope" });
}

// Localize an entity-result subtitle descriptor at render time (real @handles /
// descriptions pass through as-is; fallback labels format with the app locale).
function formatEntitySubtitle(subtitle: SearchEntitySubtitle, formatMessage: IntlShape["formatMessage"]): string {
  switch (subtitle.kind) {
    case "channel":
      return formatMessage({ id: "search.channel" });
    case "computer":
      return subtitle.hostname
        ? formatMessage({ id: "search.entComputer" }, { hostname: subtitle.hostname })
        : formatMessage({ id: "search.badgeComputer" });
    case "agentDm":
      return formatMessage({ id: "search.entAgentDm" });
    case "selfDm":
      return formatMessage({ id: "search.entSelfDm" });
    case "text":
      return subtitle.text;
  }
}

function getExclusiveSenderTypeScope(scopes: readonly SearchScope[]): "user" | "agent" | null {
  const hasHumans = scopes.includes("humans");
  const hasAgents = scopes.includes("agents");
  if (hasHumans === hasAgents) return null;
  return hasHumans ? "user" : "agent";
}

interface MessageSearchResult {
  id: string;
  channelId: string;
  threadId: string | null;
  parentMessageId: string | null;
  parentMessageContent: string | null;
  parentChannelId: string;
  parentChannelName: string;
  parentChannelType: "channel" | "private" | "joint" | "dm" | "thread";
  parentChannelArchivedAt: string | null;
  senderId: string;
  senderType: "user" | "agent" | "external_projection";
  senderName: string;
  senderAvatarUrl: string | null;
  externalMessage?: unknown;
  channelName: string;
  channelType: "channel" | "private" | "joint" | "dm" | "thread";
  channelArchivedAt: string | null;
  content: string;
  snippet: string;
  createdAt: string;
}

interface SenderFilterOption {
  key: string;
  id: string;
  type: "user" | "agent";
  label: string;
  handle: string;
  isSelf?: boolean;
  avatarUrl?: string | null;
  gravatarHash?: string | null;
  email?: string | null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getSearchEntry(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const searchEntry = (state as { searchEntry?: unknown }).searchEntry;
  return typeof searchEntry === "string" ? searchEntry : null;
}

function getValidSearchSource(state: unknown, serverSlug: string | undefined): string | null {
  if (!serverSlug || !state || typeof state !== "object") return null;
  const searchFrom = (state as { searchFrom?: unknown }).searchFrom;
  if (typeof searchFrom !== "string") return null;
  const serverBase = `/s/${serverSlug}`;
  const searchPath = `${serverBase}/search`;
  if (
    !(searchFrom === serverBase || searchFrom.startsWith(`${serverBase}/`))
    || searchFrom === searchPath
    || searchFrom.startsWith(`${searchPath}?`)
    || searchFrom.startsWith(`${searchPath}#`)
    || searchFrom.startsWith(`${searchPath}/`)
  ) {
    return null;
  }
  return searchFrom;
}

function getSearchShortcutSource(
  state: unknown,
  serverSlug: string | undefined,
): string | null {
  if (getSearchEntry(state) === "rail") return null;
  return getValidSearchSource(state, serverSlug);
}

// Returns the message KEY; the callsite formats with the active locale. Title
// Case per stdrc case-doctrine (PR #2150/#2160/#2176) lives in the en catalog.
function getTimeRangeLabelId(range: SearchTimeRange): "search.timeToday" | "search.timeLast7" | "search.timeLast30" | "search.timeAny" {
  switch (range) {
    case "today":
      return "search.timeToday";
    case "7d":
      return "search.timeLast7";
    case "30d":
      return "search.timeLast30";
    default:
      return "search.timeAny";
  }
}

function SearchHighlight({ text, query }: { text: string; query: string }) {
  const tokens = useMemo(() => {
    const parts = query
      .trim()
      .split(/\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
    return parts.length > 0 ? parts : query.trim() ? [query.trim()] : [];
  }, [query]);

  const parts = useMemo(() => {
    if (tokens.length === 0) return [text];
    const re = new RegExp(`(${tokens.map(escapeRegExp).join("|")})`, "ig");
    return text.split(re);
  }, [text, tokens]);

  if (tokens.length === 0) {
    return <>{text}</>;
  }

  return (
    <>
      {parts.map((part, index) => {
        const matched = tokens.some((token) => token.toLowerCase() === part.toLowerCase());
        return matched ? (
          <SearchMessageResultMatch key={`${part}-${index}`}>
            {part}
          </SearchMessageResultMatch>
        ) : (
          <span key={`${part}-${index}`}>{part}</span>
        );
      })}
    </>
  );
}

function SearchSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="border border-line-muted bg-layer-card p-3 theme-brutal:border-2 theme-brutal:border-black/30 theme-brutal:bg-white">
          <div className="mb-2 flex gap-2">
            <Skeleton variant="line" className="w-24" />
            <Skeleton variant="line" className="w-20" />
            <Skeleton variant="line" className="w-16" />
          </div>
          <div className="space-y-2">
            <Skeleton variant="line" className="w-full" />
            <Skeleton variant="line" className="w-4/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

interface SearchResultsBoundaryProps {
  resetKey: string;
  onRetry: () => void;
  children: ReactNode;
}

interface SearchResultsBoundaryState {
  hasError: boolean;
}

// Localized fallback UI for the error boundary. A class component can't call
// useIntl, so the boundary delegates its error render to this functional child
// (it mounts inside the app's IntlProvider like any other component).
function SearchResultsBoundaryFallback({ onRetry }: { onRetry: () => void }) {
  const { formatMessage } = useIntl();
  return (
    <div className="border border-line-muted bg-layer-card p-4 text-left shadow-raft-sm theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white theme-brutal:shadow-brutal-sm">
      <div className="mb-2 text-sm font-bold text-foreground-strong theme-brutal:text-black">{formatMessage({ id: "search.boundaryTitle" })}</div>
      <div className="mb-3 text-xs text-foreground-muted theme-brutal:text-black/70">
        {formatMessage({ id: "search.boundaryBody" })}
      </div>
      <Button
        variant="outline"
        size="sm"
        type="button"
        onClick={onRetry}
      >
        {formatMessage({ id: "search.retry" })}
      </Button>
    </div>
  );
}

class SearchResultsBoundary extends Component<SearchResultsBoundaryProps, SearchResultsBoundaryState> {
  state: SearchResultsBoundaryState = { hasError: false };

  static getDerivedStateFromError(): SearchResultsBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[Search] render failed", error);
  }

  componentDidUpdate(prevProps: SearchResultsBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      // oxlint-disable-next-line react/no-did-update-set-state -- canonical error-boundary reset: clear the caught error when the caller bumps resetKey (new search), guarded by a prop-change condition so it cannot loop. This is the documented componentDidUpdate setState pattern.
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return <SearchResultsBoundaryFallback onRetry={this.props.onRetry} />;
    }

    return this.props.children;
  }
}

export default function MessageSearchPage({ onOpenPanelRef, onDragPanelRef, activateResultsInChat = false, overlayChrome = false }: {
  onOpenPanelRef?: (ref: WorkspacePanelRef, source?: { title?: string; subtitle?: string }) => void;
  onDragPanelRef?: (event: React.DragEvent<HTMLButtonElement>, ref: WorkspacePanelRef, source?: { title?: string; subtitle?: string }) => void;
  /**
   * Overlay mode (desktop ⌘K search overlay): a SINGLE click on a result jumps
   * straight to it in chat (openResultInChat) instead of opening the col-3
   * master/detail preview — there is no col-3 in the overlay. Navigating away
   * clears the overlay's backgroundLocation, so the overlay closes itself. When
   * false (the default, i.e. the full /search page) behavior is unchanged.
   */
  activateResultsInChat?: boolean;
  /**
   * Command-palette chrome for the desktop ⌘K overlay: a slim header (the input
   * IS the top bar, search icon inline) instead of the full PanelHeader with its
   * mobile-back button + icon badge, plus tighter filter/empty-state spacing.
   * Purely presentational and gated so the full /search page (Web) is unchanged.
   */
  overlayChrome?: boolean;
} = {}) {
  const intl = useIntl();
  const { formatMessage } = intl;
  // Render reads formatMessage directly; event handlers that build
  // panel-source titles read formatMessageRef.current so they stay stable
  // across a locale switch.
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  // Search state contract (SSOT):
  // - URL params = ONLY source of truth for committed search state (q/tab/filter/page).
  // - Local state = draft input only; must NOT drive results/tabs as committed.
  // - URL writes go through ONE commit path; do NOT add bidirectional URL<->state mirror effects.
  // - External URL change (deep link / rail nav / back-forward) wins over stale draft.
  // (v1: lift this into a typed useSearchUrlController so the rule is enforced by construction, not comment.)
  const [searchParams, setSearchParams] = useLiveSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const nav = useAppNavigate();
  const serverId = useServerStore((s) => s.current?.id);
  const slug = useServerStore((s) => s.current?.slug);
  const searchShortcutSource = getSearchShortcutSource(location.state, slug);
  const searchEntry = getSearchEntry(location.state);
  const railSearchSource = searchEntry === "rail" ? getValidSearchSource(location.state, slug) : null;
  const channels = useChannelStore((s) => s.channels);
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const openDM = useChannelStore((s) => s.openDM);
  const openUserDM = useChannelStore((s) => s.openUserDM);
  const members = useServerStore((s) => s.members);
  const serverPlan = useServerStore((s) => (s.billing?.plan || s.current?.plan || "free") as ServerPlan);
  // Free-plan search keeps returning hits older than the plan's history range
  // (product decision, task #14); flag them so opening one isn't a surprise.
  // Stryker disable next-line all: the cutoff date math mirrors planService.getHistoryCutoff and is covered by the badge DOM test.
  const historyCutoffMs = useMemo(() => {
    const days = getEffectiveLimits(serverPlan).messageHistoryDays;
    return days === -1 ? null : Date.now() - days * 24 * 60 * 60 * 1000;
  }, [serverPlan]);
  const agents = useAgentStore((s) => s.agents);
  const machines = useMachineStore((s) => s.machines);
  const currentUser = useAuthStore((s) => s.user);
  const searchStateStorageKey = getSearchStateStorageKey(serverId, currentUser?.id);
  const serializedSearchParams = searchParams.toString();
  const [initialSearchRestore] = useState<{
    locationKey: string;
    params: URLSearchParams;
  } | null>(() => {
    const currentParams = new URLSearchParams(serializedSearchParams);
    const snapshot = location.pathname.endsWith("/search")
      && searchStateStorageKey
      && searchEntry !== "rail"
      && !searchParamsHaveExplicitState(currentParams)
      ? readSearchState(
        typeof window === "undefined" ? null : window.localStorage,
        searchStateStorageKey,
      )
      : null;
    const restoredParams = snapshot ? applySearchState(currentParams, snapshot) : null;
    const params = restoredParams?.toString() === serializedSearchParams
      ? null
      : restoredParams;
    return params ? { locationKey: location.key, params } : null;
  });
  // oxlint-disable-next-line react-doctor/no-event-handler -- Immutable lazy initialization provides the first-frame value; no effect or event handler sets this state.
  const visibleSearchParams = initialSearchRestore?.locationKey === location.key
    && !searchParamsHaveExplicitState(searchParams)
    ? initialSearchRestore.params
    : searchParams;
  const closeThread = useThreadStore((s) => s.closeThread);
  const inputRef = useRef<HTMLInputElement>(null);
  const filtersPortalRef = useRef<HTMLDivElement>(null);
  const resultClickTimerRef = useRef<number | null>(null);
  const entityResultClickTimerRef = useRef<number | null>(null);
  const pendingEntityResultRef = useRef<SearchEntityRecord | null>(null);
  const shortcutHint = getGlobalSearchShortcutLabel(undefined, formatMessage);

  const initialQuery = visibleSearchParams.get("q") ?? "";
  const senderIdParam = visibleSearchParams.get("senderId") ?? "";
  const channelIdParam = visibleSearchParams.get("channelId") ?? "";
  const timeRange = normalizeSearchTimeRange(visibleSearchParams.get("range"));
  const scopeParamKey = visibleSearchParams.getAll("scope").join("\0");
  const scopes = useMemo(() => normalizeSearchScopes(scopeParamKey ? scopeParamKey.split("\0") : []), [scopeParamKey]);
  const scopeSet = useMemo(() => new Set<SearchScope>(scopes), [scopes]);
  const sort = normalizeSearchSort(visibleSearchParams.get("sort"));
  const [query, setQuery] = useState(initialQuery);
  // Seed results/hasMore from the module-level snapshot so a remount caused by
  // the col-2↔col-3 swap on slot-open re-renders the previous list instantly
  // instead of flashing through "no results" while the debounced re-fetch lands.
  const [results, setResults] = useState<MessageSearchResult[]>(() => readSearchSnapshotForServer(serverId)?.results ?? []);
  const [resultsSearchQuery, setResultsSearchQuery] = useState<string>(() => readSearchSnapshotForServer(serverId)?.query ?? "");
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState<boolean>(() => readSearchSnapshotForServer(serverId)?.hasMore ?? false);
  const [searchError, setSearchError] = useState<SearchFailureKind | null>(null);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [searchNonce, setSearchNonce] = useState(0);
  const [isComposing, setIsComposing] = useState(false);
  const [selectedResultIdentity, setSelectedResultIdentity] = useState<string | null>(null);
  const selectedIndexHintRef = useRef(0);
  const [openFilterMenu, setOpenFilterMenu] = useState<"from" | "scope" | "channel" | "time" | "sort" | null>(null);
  const [channelContextMenu, setChannelContextMenu] = useState<{
    result: SearchEntityRecord;
    x: number;
    y: number;
  } | null>(null);
  const [channelFilterQuery, setChannelFilterQuery] = useState("");
  const [senderFilterQuery, setSenderFilterQuery] = useState("");
  const searchHistoryStorageKey = getSearchHistoryStorageKey(serverId, currentUser?.id);
  const searchEntityUsageStorageKey = getSearchEntityUsageStorageKey(serverId, currentUser?.id);
  const searchEntityUsageScopeKey = getSearchEntityUsageScopeKey(serverId, currentUser?.id);
  const skipNextSearchStatePersistRef = useRef(false);
  const skipNextSearchStateRestoreRef = useRef(false);
  const selectRestoredQueryRef = useRef(false);
  const lastUrlWriteRef = useRef<string | null>(null);
  const [searchHistory, setSearchHistory] = useState<string[]>(() => (
    readSearchHistory(
      typeof window === "undefined" ? null : window.localStorage,
      searchHistoryStorageKey,
    )
  ));
  const searchEntityUsage = useSearchEntityUsageStore((state) => (
    searchEntityUsageScopeKey
      ? state.scopes[searchEntityUsageScopeKey]?.usage ?? EMPTY_SEARCH_ENTITY_USAGE
      : EMPTY_SEARCH_ENTITY_USAGE
  ));
  const recordSearchEntityOpenInStore = useSearchEntityUsageStore((state) => state.recordOpen);
  const replaceSearchEntityUsageScope = useSearchEntityUsageStore((state) => state.replaceScope);

  const queryParam = visibleSearchParams.get("q") ?? "";
  const deferUntilQuery = visibleSearchParams.get("defer") === "1";
  const hasActiveFilters = hasMeaningfulMessageSearchFilter({
    senderId: senderIdParam,
    channelId: channelIdParam,
    timeRange,
    scopes,
  });
  // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family taint via task #102's render-derived overlay rows (no Effect, no setState-in-Effect added); the boolean itself is unchanged.
  const hasSearchIntent = Boolean(query.trim() || (hasActiveFilters && !deferUntilQuery));
  // Desktop ⌘K overlay with nothing typed (task #113, Slack): the palette's
  // empty state is "recent conversations" (switch back), not the full page's
  // history + frequent sections; filters wait until there is a query.
  // oxlint-disable-next-line react-doctor/no-event-handler -- same YMNNE-family taint as hasSearchIntent above (it is derived from it); a render-time boolean, no Effect, no setState.
  const overlayHome = overlayChrome && !hasSearchIntent;
  useEffect(() => {
    if (!location.pathname.endsWith("/search")) return;
    if (skipNextSearchStateRestoreRef.current) {
      skipNextSearchStateRestoreRef.current = false;
      return;
    }
    if (searchEntry === "rail") return;
    const currentParams = new URLSearchParams(serializedSearchParams);
    if (!searchStateStorageKey || searchParamsHaveExplicitState(currentParams)) return;
    const snapshot = readSearchState(
      typeof window === "undefined" ? null : window.localStorage,
      searchStateStorageKey,
    );
    if (!snapshot) return;
    const restoredParams = applySearchState(currentParams, snapshot);
    if (restoredParams.toString() === serializedSearchParams) return;
    selectRestoredQueryRef.current = Boolean(snapshot.q);
    skipNextSearchStatePersistRef.current = true;
    setSearchParams(
      (prev) => applySearchState(prev, snapshot),
      { replace: true, state: location.state },
    );
  }, [location.key, location.pathname, location.state, searchEntry, searchStateStorageKey, serializedSearchParams, setSearchParams]);

  useEffect(() => {
    if (!searchStateStorageKey) return;
    if (skipNextSearchStatePersistRef.current) {
      skipNextSearchStatePersistRef.current = false;
      return;
    }
    persistSearchState(
      typeof window === "undefined" ? null : window.localStorage,
      searchStateStorageKey,
      captureSearchState(searchParams),
    );
  }, [searchStateStorageKey, searchParams, serializedSearchParams]);

  // Search history is intentionally local and scoped to the current
  // user+server. It is a convenience surface, not server data or a
  // cross-device activity claim.
  useEffect(() => {
    setSearchHistory(readSearchHistory(
      typeof window === "undefined" ? null : window.localStorage,
      searchHistoryStorageKey,
    ));
  }, [searchHistoryStorageKey]);

  useEffect(() => {
    if (!searchEntityUsageScopeKey || Object.keys(searchEntityUsage).length > 0) return;
    const legacyUsage = readSearchEntityUsage(
      typeof window === "undefined" ? null : window.localStorage,
      searchEntityUsageStorageKey,
    );
    if (Object.keys(legacyUsage).length > 0) {
      replaceSearchEntityUsageScope(searchEntityUsageScopeKey, legacyUsage);
    }
  }, [replaceSearchEntityUsageScope, searchEntityUsage, searchEntityUsageScopeKey, searchEntityUsageStorageKey]);

  const rememberSearchQuery = useCallback((rawQuery: string) => {
    if (!searchHistoryStorageKey) return;
    setSearchHistory((current) => {
      const next = addSearchHistoryEntry(current, rawQuery);
      persistSearchHistory(
        typeof window === "undefined" ? null : window.localStorage,
        searchHistoryStorageKey,
        next,
      );
      return next;
    });
  }, [searchHistoryStorageKey]);

  const rememberCurrentSearchQuery = useCallback(() => {
    const committedQuery = getCommittedSearchQuery(query, isComposing);
    if (committedQuery) rememberSearchQuery(committedQuery);
  }, [isComposing, query, rememberSearchQuery]);

  const rememberMessageResultsSearchQuery = useCallback(() => {
    if (resultsSearchQuery) rememberSearchQuery(resultsSearchQuery);
  }, [rememberSearchQuery, resultsSearchQuery]);

  // Touch surfaces have no hover, so the per-tag remove button cannot be
  // hover-revealed there. Mobile hides it behind an explicit edit mode
  // instead; desktop keeps the hover affordance untouched.
  const isTouchSearchHome = useMediaQuery(SEARCH_HOME_TOUCH_QUERY);
  const [searchHistoryEditRequested, setSearchHistoryEditRequested] = useState(false);
  // Edit mode only exists where it is reachable: a desktop viewport keeps the
  // hover affordance and never enters it, and an empty list has nothing to
  // edit. Both are derived here rather than synchronized by an Effect.
  const searchHistoryEditing = resolveSearchHistoryEditing({
    isTouchViewport: isTouchSearchHome,
    editRequested: searchHistoryEditRequested,
    historyCount: searchHistory.length,
  });

  const forgetSearchQuery = useCallback((rawQuery: string) => {
    setSearchHistory((current) => {
      const next = removeSearchHistoryEntry(current, rawQuery);
      persistSearchHistory(
        typeof window === "undefined" ? null : window.localStorage,
        searchHistoryStorageKey,
        next,
      );
      // Removing the last entry ends the edit session outright. Without this
      // the request would still be latched, and a later search re-entering
      // history would come back with every delete button already armed.
      if (next.length === 0) setSearchHistoryEditRequested(false);
      return next;
    });
  }, [searchHistoryStorageKey]);

  const clearSearchHistory = useCallback(() => {
    setSearchHistory([]);
    setSearchHistoryEditRequested(false);
    persistSearchHistory(
      typeof window === "undefined" ? null : window.localStorage,
      searchHistoryStorageKey,
      [],
    );
  }, [searchHistoryStorageKey]);

  const rememberSearchEntityOpen = useCallback((entityKey: string) => {
    if (!searchEntityUsageScopeKey) return;
    recordSearchEntityOpenInStore(searchEntityUsageScopeKey, entityKey);
  }, [recordSearchEntityOpenInStore, searchEntityUsageScopeKey]);

  const rememberOpenedChannel = useCallback((channelId: string, kind: "channel" | "dm") => {
    if (kind === "channel") {
      rememberSearchEntityOpen(`channel:${channelId}`);
      return;
    }
    const dm = dmChannels.find((channel) => channel.id === channelId);
    if (dm?.peerType === "agent" && dm.peerId) {
      rememberSearchEntityOpen(`agent:${dm.peerId}`);
    } else if (dm?.peerType === "user" && dm.peerId) {
      rememberSearchEntityOpen(`human:${dm.peerId}`);
    }
  }, [dmChannels, rememberSearchEntityOpen]);

  // Track the last `q` value Effect A (URL writer below) wrote, so this
  // effect can distinguish "URL changed because Effect A just wrote it"
  // from "URL changed externally (rail Search click, deep link, back/forward)".
  // Without this, Effect A and the URL→input adopt effect form a SYMMETRIC
  // ping-pong on rail Search re-click: Effect A re-asserts `?q=googl` from
  // the still-stale `query` state, the next render flips, and they oscillate
  // 400+/s until something interrupts (#393, see SearchPageRailFlicker spec).
  // External URL change: q in the URL is not what Effect A last wrote. Adopt
  // the URL (it's a fresh navigation source — rail Search click, deep link,
  // back/forward), and DON'T let Effect A re-write the old `query` state on
  // top. The own-write loopback case (queryParam === lastUrlWriteRef) is a
  // no-op — Effect A already advanced the ref when it wrote.
  const isExternalUrlChange = lastUrlWriteRef.current !== null && lastUrlWriteRef.current !== queryParam;

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
    if (inputRef.current?.value) {
      inputRef.current.select();
    }
  }, []);

  useEffect(() => {
    if (!selectRestoredQueryRef.current || !query) return;
    if (searchParams.get("q") !== query) return;
    const input = inputRef.current;
    if (!input || input.value !== query) return;
    selectRestoredQueryRef.current = false;
    input.focus({ preventScroll: true });
    input.select();
  }, [query, searchParams]);

  useEffect(() => {
    return () => {
      if (resultClickTimerRef.current !== null) {
        window.clearTimeout(resultClickTimerRef.current);
      }
      if (entityResultClickTimerRef.current !== null) {
        window.clearTimeout(entityResultClickTimerRef.current);
      }
      pendingEntityResultRef.current = null;
    };
  }, []);

  useEffect(() => {
    const focusSearchInput = () => {
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.select();
    };
    document.addEventListener(SEARCH_FOCUS_REQUEST_EVENT, focusSearchInput);
    return () => document.removeEventListener(SEARCH_FOCUS_REQUEST_EVENT, focusSearchInput);
  }, []);

  const updateSearchParam = useCallback((key: string, value?: string | null) => {
    skipNextSearchStateRestoreRef.current = true;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value == null || value === "") {
        next.delete(key);
      } else {
        next.set(key, value);
      }
      return next;
    }, { replace: true, state: location.state });
  }, [location.state, setSearchParams]);

  const clearAllFilters = useCallback(() => {
    skipNextSearchStateRestoreRef.current = true;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("senderId");
      next.delete("scope");
      next.delete("range");
      next.delete("channelId");
      return next;
    }, { replace: true, state: location.state });
  }, [location.state, setSearchParams]);

  // Destination catalog + eligibility shared with the desktop History menu
  // (useRecentConversationEntities): one resolution of "what is a conversation".
  const searchEntityCatalog = useSearchEntityCatalog();
  const { entries: allEntitySearchEntries, eligibleEntityKeys: eligibleFrequentEntityKeys } = searchEntityCatalog;
  const frequentSearchEntities = useMemo(
    () => selectFrequentSearchEntities({
      entities: allEntitySearchEntries.map((entry) => entry.suggestion),
      usage: searchEntityUsage,
      eligibleEntityKeys: eligibleFrequentEntityKeys,
      currentUserId: currentUser?.id,
    }),
    [allEntitySearchEntries, currentUser?.id, eligibleFrequentEntityKeys, searchEntityUsage],
  );
  const hasSearchHomeContent = searchHistory.length > 0 || frequentSearchEntities.length > 0;
  // The conversation behind the overlay: resolved the same way MainLayout
  // decides what to float over (explicit backgroundLocation → searchFrom →
  // remembered location → server home), so entries without explicit state
  // (rail, "search this channel", deep links — task #96) exclude it too.
  const currentConversationId = conversationChannelIdFromPath(resolveSearchOverlayBackground(location)?.pathname);
  const recentConversationEntities = useRecentConversationEntities({
    catalog: searchEntityCatalog,
    enabled: overlayHome,
    excludeChannelId: currentConversationId,
  });
  const recentConversationRows = useMemo<SelectableSearchResult[]>(
    () => recentConversationEntities.map((result) => ({ key: result.key, kind: "entity" as const, result })),
    [recentConversationEntities],
  );

  const hasEntityQuery = query.trim().length > 0;
  const entitySearchEntries = useMemo(
    () => buildSearchEntityEntriesWhenQueryPresent(hasEntityQuery, {
      channels,
      members,
      agents,
      machines,
      currentUser,
      dmChannels,
    }),
    [agents, channels, currentUser, dmChannels, hasEntityQuery, machines, members],
  );
  const scopedEntitySearchEntries = useMemo(
    () => filterSearchEntityEntriesForQuery(query, entitySearchEntries),
    [entitySearchEntries, query],
  );
  const rankedEntityResults = useRankedComposerSuggestions(query, scopedEntitySearchEntries);
  const entityResults = useMemo(
    () => {
      // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family: pre-existing search draft behavior; shared ranking is render-derived and does not add an Effect.
      return query.trim() ? rankedEntityResults.slice(0, MAX_ENTITY_RESULTS) : [];
    },
    [query, rankedEntityResults],
  );
  const resolveUserMember = useCallback((userId: string | null) => (
    userId
      ? resolveMessageSenderMemberFromList({ senderType: "user", senderId: userId }, members, currentUser)
      : undefined
  ), [currentUser, members]);

  const filteredChannels = useMemo(() => {
    const normalizedQuery = channelFilterQuery.trim().toLowerCase();
    if (!normalizedQuery) return channels;
    return channels.filter((channel) => {
      const haystack = `${channel.name} ${channel.description ?? ""}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [channelFilterQuery, channels]);

  const senderOptions = useMemo<SenderFilterOption[]>(() => {
    const humans = members.map<SenderFilterOption>((member) => ({
      key: `user:${member.userId}`,
      id: member.userId,
      type: "user",
      label: member.displayName || member.name,
      handle: member.name,
      isSelf: currentUser?.id === member.userId,
      avatarUrl: member.avatarUrl,
      gravatarHash: member.gravatarHash,
      email: member.email,
    }));
    const hasCurrentUser = Boolean(currentUser?.id && humans.some((option) => option.id === currentUser.id));
    const withCurrentUser = currentUser?.id && !hasCurrentUser
      ? [
          {
            key: `user:${currentUser.id}`,
            id: currentUser.id,
            type: "user" as const,
            label: currentUser.displayName || currentUser.name || currentUser.email,
            handle: currentUser.name || currentUser.email,
            isSelf: true,
            avatarUrl: currentUser.avatarUrl,
            email: currentUser.email,
          },
          ...humans,
        ]
      : humans;
    const agentOptions = agents
      .filter((agent) => !agent.deletedAt)
      .map<SenderFilterOption>((agent) => ({
        key: `agent:${agent.id}`,
        id: agent.id,
        type: "agent",
        label: agent.displayName || agent.name,
        handle: agent.name,
        avatarUrl: agent.avatarUrl,
      }));
    return [...withCurrentUser, ...agentOptions].sort((a, b) => {
      if (a.isSelf && !b.isSelf) return -1;
      if (!a.isSelf && b.isSelf) return 1;
      return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
    });
  }, [agents, currentUser, members]);

  const filteredSenderOptions = useMemo(() => {
    const needle = senderFilterQuery.trim().toLowerCase();
    if (!needle) return senderOptions;
    return senderOptions.filter((option) => {
      const haystack = `${option.label} ${option.handle}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [senderFilterQuery, senderOptions]);

  const selectedSender = useMemo(
    () => senderOptions.find((option) => option.id === senderIdParam) ?? null,
    [senderIdParam, senderOptions],
  );

  const setSenderFilter = useCallback((sender: SenderFilterOption | null) => {
    skipNextSearchStateRestoreRef.current = true;
    if (!sender) {
      updateSearchParam("senderId", null);
      return;
    }
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("senderId", sender.id);
      const currentScopes = normalizeSearchScopes(next.getAll("scope"));
      const exclusiveSenderTypeScope = getExclusiveSenderTypeScope(currentScopes);
      if (exclusiveSenderTypeScope && sender.type !== exclusiveSenderTypeScope) {
        next.delete("scope");
        for (const mode of currentScopes) {
          if (mode === "mentioned" || (mode === "humans" && sender.type === "user") || (mode === "agents" && sender.type === "agent")) {
            next.append("scope", mode);
          }
        }
      }
      return next;
    }, { replace: true, state: location.state });
  }, [location.state, setSearchParams, updateSearchParam]);

  const setScopeFilters = useCallback((nextScopes: SearchScope[]) => {
    skipNextSearchStateRestoreRef.current = true;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("scope");
      const normalizedScopes = SEARCH_SCOPE_OPTIONS.filter((mode) => nextScopes.includes(mode));
      for (const mode of normalizedScopes) next.append("scope", mode);
      const currentSenderId = next.get("senderId");
      const currentSender = currentSenderId ? senderOptions.find((option) => option.id === currentSenderId) : null;
      const exclusiveSenderTypeScope = getExclusiveSenderTypeScope(normalizedScopes);
      if (currentSender && exclusiveSenderTypeScope && currentSender.type !== exclusiveSenderTypeScope) {
        next.delete("senderId");
      }
      return next;
    }, { replace: true, state: location.state });
  }, [location.state, senderOptions, setSearchParams]);

  // oxlint-disable-next-line react-doctor/no-effect-chain -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
  useEffect(() => {
    const trimmed = getCommittedSearchQuery(query, isComposing);
    if (trimmed === null && isComposing) return;
    if (trimmed === queryParam) {
      // URL already matches; just sync our written-value ref so a future
      // external URL change is detectable.
      lastUrlWriteRef.current = queryParam;
      return;
    }
    if (isExternalUrlChange) {
      // External nav (rail Search click, deep link, back/forward) just changed
      // the URL. The URL→input effect above will adopt it; we must NOT clobber
      // the URL with our stale `query` state, or the two effects ping-pong
      // (#393). Sync the ref to the new external value so subsequent
      // user-typed query writes land cleanly.
      lastUrlWriteRef.current = queryParam;
      return;
    }
    // Functional updater + no `searchParams` dep: the bare-object form plus
    // `searchParams` in deps made this effect re-fire on its own URL write,
    // forming a flicker loop with the `initialQuery → setQuery` effect (search
    // button re-click). Per the URL-query single-writer contract (CLAUDE.md),
    // read the latest params from `prev` and never depend on `searchParams`.
    const writtenValue = trimmed ?? "";
    lastUrlWriteRef.current = writtenValue;
    skipNextSearchStateRestoreRef.current = true;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (trimmed) {
        next.set("q", trimmed);
      } else {
        next.delete("q");
      }
      return next;
    }, { replace: true, state: location.state });
  }, [isComposing, isExternalUrlChange, location.state, query, queryParam, setSearchParams]);

  const buildMessageSearchParams = useCallback((offset: number) => {
    const trimmed = getCommittedSearchQuery(query, isComposing);
    if (trimmed === null) return null;
    const hasFilters = hasMeaningfulMessageSearchFilter({
      senderId: senderIdParam,
      channelId: channelIdParam,
      timeRange,
      scopes,
    });
    if (!trimmed && (!hasFilters || deferUntilQuery)) return null;

    const params: Record<string, string | number> = {
      q: trimmed,
      limit: PAGE_SIZE,
      offset,
    };
    const requestSort = getEffectiveMessageSearchSort(trimmed, sort);
    if (trimmed && requestSort === "recent") {
      params.sort = sort;
    }

    if (senderIdParam) {
      params.senderId = senderIdParam;
    }

    if (scopeSet.has("mentioned")) {
      params.mentionTarget = "self";
    }
    const exclusiveSenderTypeScope = getExclusiveSenderTypeScope(scopes);
    if (exclusiveSenderTypeScope === "user") {
      params.senderType = "user";
    } else if (exclusiveSenderTypeScope === "agent") {
      params.senderType = "agent";
    }

    if (channelIdParam) {
      params.channelId = channelIdParam;
    }

    const timeRangeParams = buildTimeRangeParams(timeRange);
    if (timeRangeParams.after) params.after = timeRangeParams.after;
    if (timeRangeParams.before) params.before = timeRangeParams.before;

    return params;
  }, [channelIdParam, deferUntilQuery, isComposing, query, scopeSet, scopes, senderIdParam, sort, timeRange]);

  // Async search-loader. Reset on params change + fetch + arrival commit.
  // Same async-loader FP family.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    const params = buildMessageSearchParams(0);
    if (!params) {
      setResults([]);
      setResultsSearchQuery("");
      setLoading(false);
      setLoadingMore(false);
      setHasMore(false);
      setSearchError(null);
      setLoadMoreError(false);
      cachedSearchSnapshot = null;
      return;
    }

    // If a remount lands with the same params we already have cached, the
    // initial state seeded from the snapshot is already what we'd refetch —
    // skip the network round-trip (and the loading flash) entirely.
    const paramsKey = serializeSearchParams(params);
    const snapshotServerId = serverId ?? null;
    if (readSearchSnapshotForServer(snapshotServerId)?.paramsKey === paramsKey) {
      setSearchError(null);
      setLoadMoreError(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setLoadingMore(false);
      setSearchError(null);
      setLoadMoreError(false);
      try {
        const { data } = await api.get("/messages/search", { params, signal: controller.signal });
        if (!cancelled) {
          const nextResults: MessageSearchResult[] = Array.isArray(data.results) ? data.results : [];
          const nextHasMore = Boolean(data.hasMore);
          setResults(nextResults);
          setResultsSearchQuery(typeof params.q === "string" ? params.q : "");
          setHasMore(nextHasMore);
          cachedSearchSnapshot = {
            serverId: snapshotServerId,
            paramsKey,
            query: typeof params.q === "string" ? params.q : "",
            results: nextResults,
            hasMore: nextHasMore,
          };
        }
      } catch (error: any) {
        if (error?.code === "ERR_CANCELED" || error?.name === "CanceledError") {
          return;
        }
        if (!cancelled) {
          setHasMore(false);
          setSearchError(classifySearchFailure(error));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [buildMessageSearchParams, searchNonce, serverId]);

  const loadMoreResults = useCallback(async () => {
    if (loadingMore) return;
    const params = buildMessageSearchParams(results.length);
    if (!params) return;
    setLoadingMore(true);
    setLoadMoreError(false);
    try {
      const { data } = await api.get("/messages/search", { params });
      const nextResults = Array.isArray(data.results) ? data.results as MessageSearchResult[] : [];
      setResults((prev) => [...prev, ...nextResults]);
      setHasMore(Boolean(data.hasMore));
    } catch {
      // Preserve both the current page and the continuation state so the failed
      // page is visibly retryable instead of looking like the end of results.
      setLoadMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  }, [buildMessageSearchParams, loadingMore, results.length]);

  const handleBack = useMobileBack(searchShortcutSource ?? railSearchSource ?? (slug ? `/s/${slug}` : "/"));
  const handleSearchEscape = useCallback(() => {
    const hasCommittedQuery = queryParam.trim().length > 0;
    if (hasCommittedQuery && railSearchSource) {
      navigate(railSearchSource, { replace: true });
      return;
    }
    const exitsToServerRoot =
      (!hasCommittedQuery && !searchShortcutSource && !deferUntilQuery)
      || (!!channelIdParam && !deferUntilQuery);
    if (exitsToServerRoot) {
      navigate(slug ? `/s/${slug}` : "/", { replace: true });
      return;
    }
    handleBack();
  }, [channelIdParam, deferUntilQuery, handleBack, navigate, queryParam, railSearchSource, searchShortcutSource, slug]);

  // Task #102 (Slack "Search for: … → results page"): hand the current query and
  // filters to the full results page (list + col-3 context preview). Replaces the
  // overlay's history entry so Back returns to the conversation, not to a
  // re-opened overlay. `?presentation=page` in the URL is what lets the desktop
  // render the page instead of the overlay (resolveSearchOverlayBackground); it is
  // a URL param — not history state — because the page's other URL writers
  // (preview open, thread sync) replace without state.
  const openAllResults = useCallback(() => {
    rememberCurrentSearchQuery();
    const params = new URLSearchParams(visibleSearchParams);
    params.delete("defer");
    const committedQuery = query.trim();
    if (committedQuery) params.set("q", committedQuery);
    else params.delete("q");
    params.set(SEARCH_PRESENTATION_PARAM, SEARCH_PRESENTATION_PAGE);
    navigate(
      { pathname: location.pathname, search: `?${params.toString()}` },
      { replace: true, state: fullPageSearchHopState(location.state) },
    );
  }, [location.pathname, location.state, navigate, query, rememberCurrentSearchQuery, visibleSearchParams]);

  // task #311 stdrc msg=b61ab472: clicking a result opens the picked entity
  // in col 3 of the /search master/detail layout (not navigate-away). The
  // URL sync hook in MainLayout mirrors searchContentStore → ?open=<...>.
  const openSearchContent = useSearchContentStore((s) => s.open);
  const closeSearchContent = useSearchContentStore((s) => s.close);
  const slot = useSearchContentStore((s) => s.slot);
  const slotOpen = !!slot;

  // Ref pattern: syncSelectedKey is referenced by openResult / openEntityResult
  // which are declared BEFORE selectableResults. Reading the array via ref
  // avoids the TDZ on the `const selectableResults` declared below.
  const selectableResultsRef = useRef<Array<{ key: string }>>([]);
  const syncSelectedKey = useCallback((key: string) => {
    // Clicking a card is the canonical "select this result" gesture — it
    // must update selectedResultIdentity so selectedResultKey points at the clicked
    // card. Without this, the keyboard-focus shadow stays on whatever card
    // was first-mounted (always index 0) and the clicked card draws no
    // active treatment. Reference: pre-rail search behavior — one state.
    const next = selectableResultsRef.current.findIndex((entry) => entry.key === key);
    if (next < 0) return;
    selectedIndexHintRef.current = next;
    setSelectedResultIdentity(key);
  }, []);

  const openResult = useCallback(async (result: MessageSearchResult) => {
    if (!slug) return;
    rememberMessageResultsSearchQuery();
    syncSelectedKey(`message:${result.id}`);
    // Thread hit: open the thread directly in col 3 per stdrc msg=54304d0e —
    // NOT a parent-channel + col-4-thread-overlay split. Slot.id is the
    // thread channel itself; messageId is the reply to scroll/highlight.
    //
    // First-principles correction (stdrc msg=41f5c906 2026-05-28 "点开 thread
    // 还是错位"): a thread is parent-message-anchored, NOT a regular channel
    // surface. SearchContentRoute renders <ThreadPanel embedded /> for thread
    // slots, and ThreadPanel reads from threadStore — so seed it here with
    // the parent ids we already have on the search hit. The store→URL sync
    // mirrors threadStore into ?thread=<parentChId>:<parentMsgId>, which the
    // URL→Store sync restores on cold-load deeplinks (col-4 overlay stays
    // suppressed by RightPanel's structural guard on /search).
    if (result.channelType === "thread") {
      if (result.parentChannelId && result.parentMessageId) {
        // openThread() returns a Promise we don't need to await — it sets
        // panel-open state synchronously before the network round-trip.
        // Stryker disable all: typed thread payload shape is covered by openThread payload/source contracts.
        // The hit already carries the thread channel's own id — hand it over
        // so the panel loads the thread directly instead of re-resolving it
        // through the parent-message lookup (task #14).
        void useThreadStore
          .getState()
          .openThread({
            parentChannelId: result.parentChannelId,
            parentMessageId: result.parentMessageId,
            threadChannelId: result.channelId,
            focusedMessageId: result.id,
          });
        // Stryker restore all
      }
      openSearchContent({ kind: "thread", id: result.channelId, messageId: result.id });
      return;
    }
    // DM message hit must use kind="dm" so SearchContentRoute dispatches to
    // DmById (was a bug previously misclassified as "channel"; chat panel
    // for DM has different membership / header semantics).
    const kind = result.channelType === "dm" ? "dm" : "channel";
    // Only close a col-4 thread when the chosen search result actually swaps
    // col 3 to a different entity. Re-selecting the already-open channel/DM
    // from the search input is not a context swap, so it must not collapse the
    // thread the user is currently working in.
    if (!slot || slot.kind !== kind || slot.id !== result.channelId) {
      closeThread();
    }
    openSearchContent({ kind, id: result.channelId, messageId: result.id });
    rememberOpenedChannel(result.channelId, kind);
  }, [closeThread, openSearchContent, rememberMessageResultsSearchQuery, rememberOpenedChannel, slug, slot, syncSelectedKey]);

  const openEntityResult = useCallback(async (result: SearchEntityRecord) => {
    if (!slug) return;
    rememberCurrentSearchQuery();
    syncSelectedKey(result.key);
    if (result.type === "channel" && result.channelId) {
      if (!slot || slot.kind !== "channel" || slot.id !== result.channelId) {
        closeThread();
      }
      openSearchContent({ kind: "channel", id: result.channelId });
      rememberSearchEntityOpen(result.key);
      return;
    }
    if (result.type === "computer" && result.machineId) {
      if (!slot || slot.kind !== "machine" || slot.id !== result.machineId) {
        closeThread();
      }
      openSearchContent({ kind: "machine", id: result.machineId });
      return;
    }
    try {
      if (result.type === "agentDm" && result.agentId) {
        const dmChannel = result.channelId
          ? { id: result.channelId }
          : await openDM(result.agentId);
        if (!slot || slot.kind !== "dm" || slot.id !== dmChannel.id) {
          closeThread();
        }
        openSearchContent({ kind: "dm", id: dmChannel.id });
        rememberSearchEntityOpen(result.key);
        return;
      }
      if (result.type === "humanDm" && result.userId) {
        const dmChannel = result.channelId
          ? { id: result.channelId }
          : await openUserDM(result.userId);
        if (!slot || slot.kind !== "dm" || slot.id !== dmChannel.id) {
          closeThread();
        }
        openSearchContent({ kind: "dm", id: dmChannel.id });
        rememberSearchEntityOpen(result.key);
      }
    } catch {
      if (result.type === "agentDm" && result.agentId) {
        if (!slot || slot.kind !== "agent" || slot.id !== result.agentId) {
          closeThread();
        }
        openSearchContent({ kind: "agent", id: result.agentId });
        return;
      }
      if (result.type === "humanDm" && result.userId) {
        closeThread();
        nav.toHuman(result.userId);
      }
    }
  }, [closeThread, nav, openDM, openUserDM, openSearchContent, rememberCurrentSearchQuery, rememberSearchEntityOpen, slug, slot, syncSelectedKey]);

  const openResultInChat = useCallback(async (result: MessageSearchResult) => {
    if (!slug) return;
    rememberMessageResultsSearchQuery();
    syncSelectedKey(`message:${result.id}`);
    closeSearchContent();
    if (result.channelType === "thread") {
      if (result.parentChannelId && result.parentMessageId) {
        // Route-level opening has one transition owner. The canonical URL
        // hydrates threadStore through the existing URL→store projection;
        // pre-opening the store here would add an intermediate history entry.
        nav.toThreadMessage(
          result.parentChannelId,
          result.parentMessageId,
          result.id,
          result.parentChannelType === "dm" ? "dm" : "channel",
          result.parentChannelType === "dm" ? undefined : { sidebarFocus: "center" },
        );
      } else {
        void openResult(result);
      }
      return;
    }
    closeThread();
    if (result.channelType === "dm") {
      nav.toDmMessage(result.channelId, result.id);
      rememberOpenedChannel(result.channelId, "dm");
      return;
    }
    nav.toMessage(result.channelId, result.id, { sidebarFocus: "center" });
    rememberOpenedChannel(result.channelId, "channel");
  }, [closeSearchContent, closeThread, nav, openResult, rememberMessageResultsSearchQuery, rememberOpenedChannel, slug, syncSelectedKey]);

  const openEntityResultInChat = useCallback(async (result: SearchEntityRecord) => {
    if (!slug) return;
    rememberCurrentSearchQuery();
    syncSelectedKey(result.key);
    closeSearchContent();
    closeThread();
    if (result.type === "channel" && result.channelId) {
      nav.toChannel(result.channelId, { sidebarFocus: "center" });
      rememberSearchEntityOpen(result.key);
      return;
    }
    if (result.type === "computer" && result.machineId) {
      nav.toComputer(result.machineId);
      return;
    }
    try {
      if (result.type === "agentDm" && result.agentId) {
        const dmChannel = result.channelId
          ? { id: result.channelId }
          : await openDM(result.agentId);
        nav.toDm(dmChannel.id);
        rememberSearchEntityOpen(result.key);
        return;
      }
      if (result.type === "humanDm" && result.userId) {
        const dmChannel = result.channelId
          ? { id: result.channelId }
          : await openUserDM(result.userId);
        nav.toDm(dmChannel.id);
        rememberSearchEntityOpen(result.key);
      }
    } catch {
      if (result.type === "agentDm" && result.agentId) {
        nav.toAgent(result.agentId);
        return;
      }
      if (result.type === "humanDm" && result.userId) {
        nav.toHuman(result.userId);
      }
    }
  }, [closeSearchContent, closeThread, nav, openDM, openUserDM, rememberCurrentSearchQuery, rememberSearchEntityOpen, slug, syncSelectedKey]);

  const openEntityResultFromDoubleClick = useCallback((result: SearchEntityRecord) => {
    if (!onOpenPanelRef) {
      void openEntityResultInChat(result);
      return;
    }
    rememberCurrentSearchQuery();
    if (result.type === "channel" && result.channelId) {
      onOpenPanelRef(
        { kind: "channel", id: result.channelId },
        { title: result.title, subtitle: formatEntitySubtitle(result.subtitle, formatMessageRef.current) },
      );
      rememberSearchEntityOpen(result.key);
      return;
    }
    if (result.type === "computer" && result.machineId) {
      onOpenPanelRef(
        { kind: "machine", id: result.machineId },
        { title: result.title, subtitle: formatEntitySubtitle(result.subtitle, formatMessageRef.current) },
      );
      return;
    }
    const openWorkspaceDm = async () => {
      try {
        const channelId = result.channelId
          ?? (result.type === "agentDm" && result.agentId
            ? (await openDM(result.agentId)).id
            : result.type === "humanDm" && result.userId
              ? (await openUserDM(result.userId)).id
              : null);
        if (channelId) {
          onOpenPanelRef(
            { kind: "dm", id: channelId },
            { title: result.title, subtitle: formatEntitySubtitle(result.subtitle, formatMessageRef.current) },
          );
          rememberSearchEntityOpen(result.key);
        }
      } catch {
        const detailRef = result.type === "agentDm" && result.agentId
          ? { kind: "agent", id: result.agentId } as const
          : result.type === "humanDm" && result.userId
            ? { kind: "human", id: result.userId } as const
            : null;
        if (detailRef) {
          onOpenPanelRef(detailRef, { title: result.title, subtitle: formatEntitySubtitle(result.subtitle, formatMessageRef.current) });
        }
      }
    };
    void openWorkspaceDm();
  }, [onOpenPanelRef, openDM, openEntityResultInChat, openUserDM, rememberCurrentSearchQuery, rememberSearchEntityOpen]);

  const handleMessageResultClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>, result: MessageSearchResult) => {
    if (onOpenPanelRef) {
      rememberMessageResultsSearchQuery();
      if (result.channelType === "thread" && result.parentChannelId && result.parentMessageId) {
        onOpenPanelRef(
          {
            kind: "thread",
            channelId: result.parentChannelId,
            threadRootId: result.parentMessageId,
            threadChannelId: result.channelId,
          },
          { title: formatMessageRef.current({ id: "search.panelThreadTitle" }, { id: result.parentMessageId.slice(0, 8) }), subtitle: result.parentChannelName },
        );
        return;
      }
      onOpenPanelRef(
        { kind: result.channelType === "dm" ? "dm" : "channel", id: result.channelId },
        { title: result.channelType === "dm" ? `@${result.channelName}` : `#${result.channelName}`, subtitle: formatMessageRef.current({ id: "search.panelSubtitle" }) },
      );
      rememberOpenedChannel(result.channelId, result.channelType === "dm" ? "dm" : "channel");
      return;
    }
    // Overlay mode: a single click jumps to the message in chat (there is no col-3
    // preview to open). No double-click affordance / 220ms disambiguation needed.
    if (activateResultsInChat) {
      void openResultInChat(result);
      return;
    }
    if (event.detail >= 2) {
      if (resultClickTimerRef.current !== null) {
        window.clearTimeout(resultClickTimerRef.current);
        resultClickTimerRef.current = null;
      }
      void openResultInChat(result);
      return;
    }
    if (resultClickTimerRef.current !== null) {
      window.clearTimeout(resultClickTimerRef.current);
    }
    resultClickTimerRef.current = window.setTimeout(() => {
      resultClickTimerRef.current = null;
      void openResult(result);
    }, 220);
  }, [activateResultsInChat, onOpenPanelRef, openResult, openResultInChat, rememberMessageResultsSearchQuery, rememberOpenedChannel]);

  const handleEntityResultClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>, result: SearchEntityRecord) => {
    if (onOpenPanelRef) {
      openEntityResultFromDoubleClick(result);
      return;
    }
    // Overlay mode: a single click jumps to the entity in chat (no col-3 preview).
    if (activateResultsInChat) {
      void openEntityResultInChat(result);
      return;
    }
    if (event.detail >= 2) {
      if (entityResultClickTimerRef.current !== null) {
        window.clearTimeout(entityResultClickTimerRef.current);
        entityResultClickTimerRef.current = null;
      }
      pendingEntityResultRef.current = null;
      openEntityResultFromDoubleClick(result);
      return;
    }
    if (entityResultClickTimerRef.current !== null) {
      window.clearTimeout(entityResultClickTimerRef.current);
      entityResultClickTimerRef.current = null;
      const pendingResult = pendingEntityResultRef.current;
      pendingEntityResultRef.current = null;
      if (pendingResult && pendingResult.key !== result.key) {
        void openEntityResult(pendingResult);
      }
    }
    pendingEntityResultRef.current = result;
    entityResultClickTimerRef.current = window.setTimeout(() => {
      entityResultClickTimerRef.current = null;
      const pendingResult = pendingEntityResultRef.current;
      pendingEntityResultRef.current = null;
      if (pendingResult) {
        void openEntityResult(pendingResult);
      }
    }, 220);
  }, [activateResultsInChat, onOpenPanelRef, openEntityResult, openEntityResultFromDoubleClick, openEntityResultInChat]);

  const handleChannelResultContextMenu = useCallback((
    event: ReactMouseEvent,
    result: SearchEntityRecord,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const position = placeContextMenu({
      x: event.clientX,
      y: event.clientY,
      width: 192,
      height: 40,
    });
    setChannelContextMenu({
      result,
      x: position.x,
      y: position.y,
    });
  }, []);

  const handleMessageResultDrag = useCallback((event: React.DragEvent<HTMLButtonElement>, result: MessageSearchResult) => {
    if (!onDragPanelRef) return;
    if (result.channelType === "thread" && result.parentChannelId && result.parentMessageId) {
      onDragPanelRef(
        event,
        {
          kind: "thread",
          channelId: result.parentChannelId,
          threadRootId: result.parentMessageId,
          threadChannelId: result.channelId,
        },
        { title: formatMessageRef.current({ id: "search.panelThreadTitle" }, { id: result.parentMessageId.slice(0, 8) }), subtitle: result.parentChannelName },
      );
      return;
    }
    onDragPanelRef(
      event,
      { kind: result.channelType === "dm" ? "dm" : "channel", id: result.channelId },
      { title: result.channelType === "dm" ? `@${result.channelName}` : `#${result.channelName}`, subtitle: formatMessageRef.current({ id: "search.panelSubtitle" }) },
    );
  }, [onDragPanelRef]);

  const handleEntityResultDrag = useCallback((event: React.DragEvent<HTMLButtonElement>, result: SearchEntityRecord) => {
    if (!onDragPanelRef) return;
    if (result.type === "channel" && result.channelId) {
      onDragPanelRef(event, { kind: "channel", id: result.channelId }, { title: result.title, subtitle: formatEntitySubtitle(result.subtitle, formatMessageRef.current) });
      return;
    }
    if (result.type === "computer" && result.machineId) {
      onDragPanelRef(event, { kind: "machine", id: result.machineId }, { title: result.title, subtitle: formatEntitySubtitle(result.subtitle, formatMessageRef.current) });
      return;
    }
    if (result.channelId) {
      onDragPanelRef(event, { kind: "dm", id: result.channelId }, { title: result.title, subtitle: formatEntitySubtitle(result.subtitle, formatMessageRef.current) });
      return;
    }
    if (result.type === "agentDm" && result.agentId) {
      onDragPanelRef(event, { kind: "agent", id: result.agentId }, { title: result.title, subtitle: formatEntitySubtitle(result.subtitle, formatMessageRef.current) });
    } else if (result.type === "humanDm" && result.userId) {
      onDragPanelRef(event, { kind: "human", id: result.userId }, { title: result.title, subtitle: formatEntitySubtitle(result.subtitle, formatMessageRef.current) });
    }
  }, [onDragPanelRef]);

  // Overlay mode previews only the first few hits (Slack "Recent messages"); the
  // full list, Load More and the col-3 preview live on the results page.
  const messagePreviewLimit = activateResultsInChat ? OVERLAY_MESSAGE_PREVIEW_LIMIT : Number.POSITIVE_INFINITY;
  const visibleMessageResults = useMemo(
    // oxlint-disable-next-line react-doctor/no-event-handler -- render-derived preview cap (task #102); the only downstream Effect is the pre-existing selection reconciliation.
    () => results.slice(0, messagePreviewLimit),
    [messagePreviewLimit, results],
  );
  const groupedMessageResults = useMemo(
    () => groupMessageSearchResults(visibleMessageResults),
    [visibleMessageResults]
  );
  const retrySearch = useCallback(() => {
    // Retry must clear the last crashing result set before the debounced fetch starts,
    // otherwise the boundary can immediately trip again on the same data.
    // The module-level cache must be dropped too, otherwise the same-params
    // short-circuit in the fetch effect would skip the refetch we want here.
    cachedSearchSnapshot = null;
    const reset = buildSearchRetryReset();
    setResults(reset.results);
    setResultsSearchQuery("");
    setLoading(reset.loading);
    setLoadingMore(reset.loadingMore);
    setHasMore(reset.hasMore);
    setSearchError(reset.searchError);
    setLoadMoreError(false);
    setSearchNonce((prev) => prev + 1);
  }, []);

  // Overlay (task #102, Slack model): an exact destination match ranks above the
  // "view all results" row (Return enters that channel / DM); otherwise that row is
  // first (Return opens the full results page). Remaining destinations and the
  // message preview follow. Full page: unchanged order, no action row.
  // oxlint-disable-next-line react-doctor/no-event-handler -- render-derived row visibility (task #102): composes the overlay's selectable rows, no Effect or setState-in-Effect involved.
  const showAllResultsAction = activateResultsInChat && hasSearchIntent;
  // Searched over the FULL ranked list (not the MAX_ENTITY_RESULTS slice): the
  // looser ranking score can place a punctuation-different sibling first, and a
  // strict match may sit past the display cut. See findExactDestination.
  const exactDestinationCandidate = useMemo(
    () => findExactDestination(query, rankedEntityResults),
    [query, rankedEntityResults],
  );
  const exactDestination = showAllResultsAction ? exactDestinationCandidate : null;
  const allResultsRow = showAllResultsAction ? OVERLAY_ALL_RESULTS_ROW : null;
  const exactDestinationRow = useMemo<SelectableSearchResult | null>(
    () => (exactDestination === null ? null : { key: exactDestination.key, kind: "entity", result: exactDestination }),
    [exactDestination],
  );
  const remainingEntityResults = useMemo(
    () => (exactDestination ? entityResults.filter((result) => result.key !== exactDestination.key) : entityResults),
    [entityResults, exactDestination],
  );
  const selectableResults = useMemo<SelectableSearchResult[]>(
    () => [
      // Overlay empty state: the recent-conversation rows are the keyboard rail
      // (↑↓ + Return, first row active by default like Slack).
      ...recentConversationRows,
      ...[exactDestinationRow, allResultsRow].filter(isSelectableRow),
      ...remainingEntityResults.map((result) => ({ key: result.key, kind: "entity" as const, result })),
      // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
      ...visibleMessageResults.map((result) => ({ key: `message:${result.id}`, kind: "message" as const, result })),
    ],
    [allResultsRow, exactDestinationRow, recentConversationRows, remainingEntityResults, visibleMessageResults]
  );
  selectableResultsRef.current = selectableResults;

  // Results arrive in independent waves (local entity ranking, worker reranks,
  // then message search). The keyboard cursor belongs to a stable result, not
  // to whichever row currently occupies its numeric index. Preserve that key
  // across refreshes; if the selected result disappeared, stay at the nearest
  // surviving position instead of surprising the user by jumping to the top.
  // Overlay (task #102): a palette's cursor returns to the top row whenever the
  // query changes (or an exact destination surfaces from a later rerank), so Return
  // always means "the first row for what I just typed" — the exact destination if
  // any, else "view all results". Adjusted during render (same-component setState),
  // and a cleared identity maps to row 0 here instead of the nearest-survivor hint.
  // Full page keeps the nearest-survivor behaviour untouched.
  const overlayCursorEpoch = activateResultsInChat ? `${query}\u0000${exactDestination?.key ?? ""}` : null;
  const [seenOverlayCursorEpoch, setSeenOverlayCursorEpoch] = useState(overlayCursorEpoch);
  if (overlayCursorEpoch !== seenOverlayCursorEpoch) {
    setSeenOverlayCursorEpoch(overlayCursorEpoch);
    if (overlayCursorEpoch !== null && selectedResultIdentity !== null) setSelectedResultIdentity(null);
  }
  const identityIndex = selectedResultIdentity
    ? selectableResults.findIndex((entry) => entry.key === selectedResultIdentity)
    : -1;
  const selectedIndex = identityIndex >= 0
    ? identityIndex
    : selectableResults.length > 0
      ? (activateResultsInChat ? 0 : Math.min(selectedIndexHintRef.current, selectableResults.length - 1))
      : 0;
  const selectedResultKey = selectableResults[selectedIndex]?.key;
  const entityResultsListRef = useRef<HTMLDivElement>(null);
  // The entity list scrolls on its own; keep the keyboard-selected row visible
  // inside it (↑↓ past the fifth row would otherwise select an off-screen row).
  useEffect(() => {
    const activeRow = entityResultsListRef.current?.querySelector<HTMLElement>("[data-active=\"true\"]");
    activeRow?.scrollIntoView({ block: "nearest" });
  }, [selectedResultKey]);
  useEffect(() => {
    selectedIndexHintRef.current = selectedIndex;
    const nextIdentity = selectableResults[selectedIndex]?.key ?? null;
    if (nextIdentity === selectedResultIdentity) return;
    // When the selected row disappears, selectedIndex is the nearest surviving
    // position. Promote that survivor to the canonical identity immediately so
    // a later insertion/rerank continues following the same row instead of the
    // old numeric position.
    // oxlint-disable-next-line react-doctor/no-derived-state -- result removal intentionally reconciles the user-owned selection identity to its nearest surviving row.
    setSelectedResultIdentity(nextIdentity);
  }, [selectableResults, selectedIndex, selectedResultIdentity]);


  // Search-rail keyboard handler. Scoped to the rail container via React
  // onKeyDown on the root <div>, so it only fires when focus is inside the
  // rail (search input, filter buttons, or a result card). When the col-3
  // slot opens a thread/channel and focus moves to its composer textarea,
  // keydown there bubbles within col-3's subtree and never reaches this
  // handler — the prior document-level listener required target-sniffing
  // guards (`isEditableKeyboardTarget` + `defaultPrevented` + a special
  // case for the search input) to avoid hijacking composer Enter/Arrow,
  // and a regression in any of those guards would close the slot from
  // anywhere on the page. Scoping by DOM subtree removes the whole
  // attack surface: focus location is the source of truth.
  const handleRailKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isSearchKeyboardComposing(event)) return;
    if (event.key === "Escape") {
      // Overlay mode: SearchOverlay owns Escape-to-dismiss. A plain Escape (no
      // filter menu open) must bubble to it — don't preventDefault and don't run
      // the page's slot-close / back-navigation here, or the overlay would either
      // never close (we swallowed the event) or double-act with its onClose.
      if (activateResultsInChat) return;
      event.preventDefault();
      if (slotOpen) {
        closeSearchContent();
        return;
      }
      handleSearchEscape();
      return;
    }
    if (!selectableResults.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const nextIndex = Math.min(selectedIndex + 1, selectableResults.length - 1);
      selectedIndexHintRef.current = nextIndex;
      setSelectedResultIdentity(selectableResults[nextIndex]?.key ?? null);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      const nextIndex = Math.max(selectedIndex - 1, 0);
      selectedIndexHintRef.current = nextIndex;
      setSelectedResultIdentity(selectableResults[nextIndex]?.key ?? null);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      const selected = selectableResults[selectedIndex];
      if (selected) {
        event.preventDefault();
        if (selected.kind === "allResults") {
          openAllResults();
          return;
        }
        // Overlay mode: keyboard activation matches a mouse click — jump to the
        // hit in chat (no col-3 preview in the overlay), which closes the overlay.
        if (selected.kind === "entity") {
          void (activateResultsInChat ? openEntityResultInChat(selected.result) : openEntityResult(selected.result));
        } else {
          void (activateResultsInChat ? openResultInChat(selected.result) : openResult(selected.result));
        }
      }
    }
  };

  const totalResults = entityResults.length + results.length;
  const boundaryKey = `${queryParam}|${senderIdParam}|${scopes.join(",")}|${timeRange}|${sort}|${searchNonce}|${channelIdParam}`;
  const showInitialSkeleton = loading && entityResults.length === 0 && results.length === 0 && !searchError;

  // Single "active result" state — selectedResultKey, driven by keyboard
  // arrows AND click (via syncSelectedKey). Mirrors the pre-rail search
  // page: there is no separate "opened-in-slot" visual; clicking a card
  // makes it the selected card AND opens it in col 3. Reference: stdrc
  // msg=c1a7f1e2 (2026-05-27) "参考原来的搜索页面". Deep-link sync: when
  // the slot is restored from `?open=...&msg=...`, walk selectableResults
  // and point the selection identity at the matching card so the visual follows the
  // slot without a click.
  useEffect(() => {
    if (!slot) return;
    const match = selectableResults.findIndex((entry) => {
      if (entry.kind === "message") {
        const r = entry.result;
        if (r.channelType === "thread") {
          return slot.kind === "thread" && slot.messageId === r.id;
        }
        const expectedKind = r.channelType === "dm" ? "dm" : "channel";
        return slot.kind === expectedKind && slot.messageId === r.id;
      }
      if (entry.kind !== "entity") return false;
      const e = entry.result;
      if (e.type === "channel") {
        return slot.kind === "channel" && slot.id === e.channelId && !slot.messageId;
      }
      if (e.type === "computer") {
        return slot.kind === "machine" && slot.id === e.machineId;
      }
      if (e.type === "agentDm") {
        return (slot.kind === "dm" && slot.id === e.channelId && !slot.messageId)
          || (slot.kind === "agent" && slot.id === e.agentId);
      }
      if (e.type === "humanDm") {
        return (slot.kind === "dm" && slot.id === e.channelId && !slot.messageId)
          || (slot.kind === "human" && slot.id === e.userId);
      }
      return false;
    });
    // Deep-link sync from external slot state — find the result matching
    // the currently-open slot and point selection at it. NOT a mirror-prop:
    // selection is user-driven (keyboard arrows + click)
    // and this effect only nudges it once on slot restore. Same async-arrival
    // recognition family as AddMembersDialog seed-on-list-arrival.
    if (match >= 0) {
      selectedIndexHintRef.current = match;
      // oxlint-disable-next-line react-doctor/no-derived-state -- external deep-link slot restoration intentionally selects the matching result identity once it arrives.
      setSelectedResultIdentity(selectableResults[match]?.key ?? null);
    }
  }, [slot, selectableResults]);

  const getSourceLabel = useCallback((result: MessageSearchResult) => {
    const isDm = result.channelType === "thread"
      ? result.parentChannelType === "dm"
      : result.channelType === "dm";
    const sourceChannelId = result.channelType === "thread"
      ? result.parentChannelId
      : result.channelId;
    const rawName = result.channelType === "thread"
      ? result.parentChannelName
      : result.channelName;
    const dmPeer = isDm
      ? dmChannels.find((channel) => channel.id === sourceChannelId)
      : null;
    const displayName = dmPeer
      ? (dmPeer.peerDisplayName || dmPeer.peerName || rawName)
      : rawName;
    return isDm ? `@${displayName}` : `#${displayName}`;
  }, [dmChannels]);

  const renderMessageHit = useCallback((result: MessageSearchResult, nested = false) => {
    const agent = result.senderType === "agent"
      ? agents.find((entry) => entry.id === result.senderId)
      : null;
    const member = result.senderType === "user"
      ? resolveMessageSenderMemberFromList(result, members, currentUser)
      : null;
    const sourceLabel = getSourceLabel(result);
    const resultKey = `message:${result.id}`;
    const isSelected = selectedResultKey === resultKey;

    const Result = nested ? SearchThreadMessageResult : SearchMessageResult;

    return (
      <Result
        key={result.id}
        type="button"
        draggable={!!onDragPanelRef}
        onDragStart={(event) => handleMessageResultDrag(event, result)}
        onClick={(event) => handleMessageResultClick(event, result)}
        selected={isSelected}
        className={nested ? "border-t-2" : undefined}
      >
        <SearchMessageResultHeader>
          <SearchMessageResultMeta>{sourceLabel}</SearchMessageResultMeta>
          {result.channelType === "thread" && (
            <SearchMessageResultThreadMeta>
              <ThreadIcon width={10} height={10} />
              {formatMessage({ id: "search.threadInline" })}
            </SearchMessageResultThreadMeta>
          )}
          {(result.channelType === "thread"
            ? result.parentChannelArchivedAt
            : result.channelArchivedAt) && (
            <Badge appearance="soft" variant="warning" uppercase>
              {formatMessage({ id: "search.archived" })}
            </Badge>
          )}
          {historyCutoffMs !== null && new Date(result.createdAt).getTime() < historyCutoffMs && (
            <Badge appearance="soft" variant="warning" data-testid="search-hit-beyond-history">
              {formatMessage({ id: "search.beyondHistory" })}
            </Badge>
          )}
          <SearchMessageResultSender>
            {result.senderType === "agent" ? (
              <AvatarSlot context="preview-mini" type="agent" agentAvatarUrl={agent?.avatarUrl ?? null} />
            ) : result.senderType === "external_projection" ? (
              <AvatarSlot context="preview-mini" type="app" appAvatarUrl={result.senderAvatarUrl} appInitials={result.senderName} />
            ) : (
              <AvatarSlot context="preview-mini" type="human" humanAvatarUrl={member?.avatarUrl} gravatarHash={member?.gravatarHash} />
            )}
            <span>{result.senderName}</span>
          </SearchMessageResultSender>
          <SearchMessageResultTimestamp>{(() => {
            const parts = getSearchRelativeTimeParts(result.createdAt);
            return parts ? formatRelativeTimeParts(parts.value, parts.unit, intl.locale) : formatMessage({ id: "search.grpUnknownTime" });
          })()}</SearchMessageResultTimestamp>
        </SearchMessageResultHeader>
        <SearchMessageResultBody>
          <SearchHighlight text={result.snippet} query={query} />
        </SearchMessageResultBody>
      </Result>
    );
  }, [agents, currentUser, formatMessage, getSourceLabel, handleMessageResultClick, handleMessageResultDrag, historyCutoffMs, intl, members, onDragPanelRef, query, selectedResultKey]);

  const chooseSearchHistoryEntry = useCallback((historyQuery: string) => {
    setQuery(historyQuery);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.setSelectionRange(historyQuery.length, historyQuery.length);
    });
  }, []);

  const renderSearchHomeEntity = useCallback((result: SearchEntityRecord) => (
    <SearchEntityResult
      key={result.key}
      type="button"
      data-testid={`search-common-${result.key}`}
      // Same activation contract as the result list and the keyboard path:
      // in the ⌘K overlay (activateResultsInChat) a click must jump to the
      // entity in chat — openEntityResult only fills the col-3 content slot,
      // which the overlay does not render, so the click looked dead (task #95).
      onClick={() => {
        void (activateResultsInChat ? openEntityResultInChat(result) : openEntityResult(result));
      }}
    >
      <SearchEntityResultLeading>
        {result.type === "channel" ? (
          <SearchEntityResultIcon>
            <ChannelKindIcon type={result.channelType ?? "channel"} />
          </SearchEntityResultIcon>
        ) : result.type === "computer" ? (
          <SearchEntityResultIcon>
            <Monitor size={14} />
          </SearchEntityResultIcon>
        ) : result.type === "agentDm" ? (
          <AvatarSlot
            context="surface-list"
            type="agent"
            agentAvatarUrl={result.agentId
              ? agents.find((entry) => entry.id === result.agentId)?.avatarUrl ?? null
              : null}
            badge={result.agentId ? <AgentActivityDot agentId={result.agentId} /> : undefined}
          />
        ) : (
          (() => {
            const member = resolveUserMember(result.userId);
            return (
              <AvatarSlot
                context="surface-list"
                type="human"
                humanAvatarUrl={member?.avatarUrl}
                gravatarHash={member?.gravatarHash}
              />
            );
          })()
        )}
      </SearchEntityResultLeading>
      <SearchEntityResultContent>
        <SearchEntityResultHeader>
          <SearchEntityResultTitle>{result.title}</SearchEntityResultTitle>
        </SearchEntityResultHeader>
        <SearchEntityResultDescription>
          {formatEntitySubtitle(result.subtitle, formatMessage)}
        </SearchEntityResultDescription>
      </SearchEntityResultContent>
    </SearchEntityResult>
  ), [activateResultsInChat, agents, formatMessage, openEntityResult, openEntityResultInChat, resolveUserMember]);

  // The query input + clear button + Esc hint, shared by both the full-page
  // PanelHeader and the slim overlay header so the field behavior is identical.
  // Overlay: no ⌘K hint inside the field you just opened with ⌘K (Slack's
  // "Channels, people, files, and more").
  const searchPlaceholder = overlayChrome
    ? formatMessage({ id: "search.overlay.placeholder" })
    : formatMessage({ id: "search.placeholder" }, { shortcutHint });
  const searchFieldInner = (
    <InputGroup className="min-w-0 flex-1">
      <InputGroupInput
        ref={inputRef}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
        }}
        onCompositionStart={() => {
          setIsComposing(true);
        }}
        onCompositionEnd={(event) => {
          setQuery(event.currentTarget.value);
          setIsComposing(false);
        }}
        placeholder={searchPlaceholder}
        aria-label={searchPlaceholder}
      />
      <InputGroupAddon align="inline-end">
        {query ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => setQuery("")}
            aria-label={formatMessage({ id: "search.clearSearch" })}
          >
            <X aria-hidden size={12} />
          </Button>
        ) : null}
        <Kbd className="hidden sm:inline text-[10px] font-bold uppercase text-foreground-muted">
          Esc
        </Kbd>
      </InputGroupAddon>
    </InputGroup>
  );

  // Destination (entity) row — shared by the overlay's exact-match head row and
  // the destinations section (task #102), so both render identically.
  const renderEntityResultRow = (result: SearchEntityRecord, options: { returnHint?: boolean } = {}) => {
  const channelPinnedRef = result.type === "channel" && result.channelId
    ? { kind: "channel", id: result.channelId } as const
    : null;
  const isArchivedChannelResult = result.type === "channel" && !!result.archivedAt;
  const hasOpenChannelContextMenu = channelPinnedRef !== null
    && channelContextMenu?.result.channelId === channelPinnedRef.id;
  const isSelected = selectedResultKey === result.key || hasOpenChannelContextMenu;

  // The card frame, hover and selected states belong to rui's
  // SearchEntityResult. A second square frame on this wrapper showed its dark
  // corners around rui's rounded selection ring (task #694).
  return (
    <div
      key={result.key}
      data-testid={channelPinnedRef ? `search-channel-result-${channelPinnedRef.id}` : undefined}
      data-active={isSelected ? "true" : undefined}
      onContextMenu={
        channelPinnedRef && !result.archivedAt
          ? (event) => handleChannelResultContextMenu(event, result)
          : undefined
      }
      className="flex w-full"
    >
      <SearchEntityResult
        type="button"
        draggable={!!onDragPanelRef}
        onDragStart={(event) => handleEntityResultDrag(event, result)}
        onClick={(event) => handleEntityResultClick(event, result)}
        selected={isSelected}
        className="theme-brutal:hover:shadow-brutal-sm theme-brutal:active:shadow-brutal-sm theme-brutal:data-[selected=true]:shadow-brutal-sm"
      >
        <SearchEntityResultLeading>
          {result.type === "channel" ? (
            <SearchEntityResultIcon
              className={isArchivedChannelResult ? ARCHIVED_CHANNEL_ICON_CLASS : undefined}
            >
              <ChannelKindIcon type={result.channelType ?? "channel"} />
            </SearchEntityResultIcon>
          ) : result.type === "computer" ? (
            <SearchEntityResultIcon>
              <Monitor size={14} />
            </SearchEntityResultIcon>
          ) : result.type === "agentDm" ? (
            result.agentId ? (
              <AvatarSlot
                context="surface-list"
                type="agent"
                agentAvatarUrl={agents.find((entry) => entry.id === result.agentId)?.avatarUrl ?? null}
                badge={<AgentActivityDot agentId={result.agentId} />}
              />
            ) : (
              <AvatarSlot context="surface-list" type="agent" agentAvatarUrl={null} />
            )
          ) : result.userId ? (
            (() => {
              const member = resolveUserMember(result.userId);
              return (
                <AvatarSlot
                  context="surface-list"
                  type="human"
                  humanAvatarUrl={member?.avatarUrl}
                  gravatarHash={member?.gravatarHash}
                />
              );
            })()
          ) : (
            <AvatarSlot context="surface-list" type="human" humanPlaceholder />
          )}
        </SearchEntityResultLeading>
        <SearchEntityResultContent>
          <SearchEntityResultHeader>
            <span className={`truncate text-sm font-bold ${isArchivedChannelResult ? ARCHIVED_CHANNEL_TEXT_CLASS : "text-foreground-strong"}`}>
              {result.title}
            </span>
            {(() => {
              const typeLabel = result.type === "channel" ? formatMessage({ id: "search.channel" }) : result.type === "computer" ? formatMessage({ id: "search.badgeComputer" }) : result.type === "agentDm" ? formatMessage({ id: "search.badgeAgent" }) : formatMessage({ id: "search.badgeHuman" });
              return isArchivedChannelResult ? (
                <span className={`${ARCHIVED_CHANNEL_BADGE_CLASS} uppercase`}>{typeLabel}</span>
              ) : (
                <Badge appearance="soft" variant="muted" uppercase>{typeLabel}</Badge>
              );
            })()}
            {result.archivedAt && (
              <span className={`${isArchivedChannelResult ? ARCHIVED_CHANNEL_BADGE_CLASS : "border border-warning bg-warning-soft px-1 py-0.5 text-[9px] font-bold leading-none text-warning-strong theme-brutal:border-black theme-brutal:bg-brutal-orange/30 theme-brutal:text-black"} uppercase`}>
                {formatMessage({ id: "search.archived" })}
              </span>
            )}
          </SearchEntityResultHeader>
          <SearchEntityResultDescription className={isArchivedChannelResult ? ARCHIVED_CHANNEL_MUTED_TEXT_CLASS : undefined}>
            {formatEntitySubtitle(result.subtitle, formatMessage)}
          </SearchEntityResultDescription>
        </SearchEntityResultContent>
        {options.returnHint && isSelected ? <Kbd aria-hidden="true">{RETURN_KEY_GLYPH}</Kbd> : null}
      </SearchEntityResult>
    </div>
  );
  };

  const activeFilterClass =
    "border-line-strong bg-primary-soft text-foreground-strong shadow-raft-sm theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-soft-signal theme-brutal:text-black theme-brutal:shadow-brutal-sm";

  const centeredEmptyState = (
    <div className="flex h-full flex-col items-center justify-center text-center" data-testid="search-home">
      <Search size={overlayChrome ? 32 : 48} className="mb-3 text-foreground-muted/30 theme-brutal:text-black/20" />
      <p className="text-sm font-bold text-foreground-muted theme-brutal:text-black/50">{formatMessage({ id: "search.emptyTitle" })}</p>
      <p className="mt-1 text-xs text-foreground-muted/70 theme-brutal:text-black/40">
        {formatMessage({ id: "search.emptyBody" })}
      </p>
    </div>
  );

  return (
    <SearchShellRoot className="flex min-h-0 flex-1 flex-col" onKeyDown={handleRailKeyDown}>
      {overlayChrome ? (
        /* Slim command-palette header (desktop ⌘K overlay): the input IS the top
           bar with the search icon inline — no PanelHeader, mobile-back, or icon
           badge. */
        <div className="shrink-0 border-b border-line-muted px-3 py-2.5 theme-brutal:border-b-2 theme-brutal:border-black">
          <div className="flex min-w-0 items-center gap-2">
            <Search size={16} className="shrink-0 text-foreground-muted theme-brutal:text-black/50" aria-hidden="true" />
            {searchFieldInner}
          </div>
        </div>
      ) : (
        <PanelHeader
          onMobileBack={handleBack}
          mobileBackProps={{ "data-testid": "search-mobile-back", title: formatMessage({ id: "search.back" }) }}
          titleSlot={
            <div className="flex min-w-0 flex-1 items-center gap-3">
              {/* Search icon — always visible on this surface (unlike other
                  panel headers where icon is desktop-only) since search
                  identity matters at every viewport. */}
              <div className="flex size-icon-header shrink-0 items-center justify-center border border-line-muted bg-primary-soft text-foreground-strong theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-soft-signal theme-brutal:text-black">
                <Search size={18} />
              </div>
              {searchFieldInner}
            </div>
          }
        />
      )}

      {overlayHome ? null : (
      <SearchShellFilters ref={filtersPortalRef} className={overlayChrome ? "px-3 py-2" : undefined}>
        <div className="flex flex-wrap items-center gap-2">
          <Combobox<string>
            autoHighlight
            open={openFilterMenu === "from"}
            onOpenChange={(open) => setOpenFilterMenu(open ? "from" : null)}
            inputValue={senderFilterQuery}
            items={filteredSenderOptions.map((item) => item.id)}
            itemToStringLabel={(id) => senderOptions.find((item) => item.id === id)?.label ?? id}
            value={senderIdParam ?? null}
            onInputValueChange={(nextValue, details) => {
              if (details.reason !== "item-press") setSenderFilterQuery(nextValue);
            }}
            onValueChange={(nextValue) => {
              const sender = senderOptions.find((item) => item.id === nextValue) ?? null;
              setSenderFilter(sender);
            }}
          >
            <ComboboxTrigger
              aria-label={formatMessage({ id: "search.from" })}
              render={<PickerTriggerButton className={senderIdParam ? activeFilterClass : undefined} />}
            >
              <UserCircle2 aria-hidden size={14} />
              <span>
                {selectedSender
                  ? formatMessage(
                      { id: "search.fromWithName" },
                      { name: selectedSender.isSelf ? formatMessage({ id: "search.fromMe" }) : selectedSender.label },
                    )
                  : formatMessage({ id: "search.from" })}
              </span>
              <ComboboxTriggerIndicator>
                <ChevronDown aria-hidden size={12} />
              </ComboboxTriggerIndicator>
            </ComboboxTrigger>
            <ComboboxContent
              align="start"
              finalFocus={false}
              initialFocus={false}
              portalProps={{ container: filtersPortalRef }}
            >
              <ComboboxHeader>
                <ComboboxLabel>{formatMessage({ id: "search.from" })}</ComboboxLabel>
                {senderIdParam && (
                  <ComboboxClear onClick={() => updateSearchParam("senderId", null)}>
                    {formatMessage({ id: "ui.selectionPopover.clear" })}
                  </ComboboxClear>
                )}
              </ComboboxHeader>
              <ComboboxSeparator />
              <ComboboxInputGroup>
                <ComboboxInput
                  aria-label={formatMessage({ id: "search.from" })}
                  placeholder={formatMessage({ id: "ui.selectionPopover.searchPlaceholder" })}
                  suppressPasswordManager
                />
              </ComboboxInputGroup>
              <ComboboxList>
                {filteredSenderOptions.map((sender) => (
                  <ComboboxItem key={sender.id} value={sender.id}>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="flex size-5 shrink-0 items-center justify-center">
                        <AvatarSlot
                          context="compact-list"
                          type={sender.type === "agent" ? "agent" : "human"}
                          agentAvatarUrl={sender.type === "agent" ? sender.avatarUrl ?? null : null}
                          humanAvatarUrl={sender.type === "user" ? sender.avatarUrl ?? null : null}
                          gravatarHash={sender.type === "user" ? sender.gravatarHash ?? null : null}
                          email={sender.type === "user" ? sender.email ?? null : null}
                        />
                      </span>
                      <span className="truncate">{sender.isSelf ? formatMessage({ id: "search.fromMe" }) : sender.label}</span>
                    </span>
                    <ComboboxItemIndicator />
                  </ComboboxItem>
                ))}
              </ComboboxList>
              <ComboboxEmpty>{formatMessage({ id: "ui.selectionPopover.emptyLabel" })}</ComboboxEmpty>
            </ComboboxContent>
          </Combobox>

          <Select<SearchScope, true>
            multiple
            open={openFilterMenu === "scope"}
            onOpenChange={(open) => setOpenFilterMenu(open ? "scope" : null)}
            items={SEARCH_SCOPE_OPTIONS.map((mode) => ({
              label: formatMessage({ id: getScopeOptionLabelId(mode) }),
              value: mode,
            }))}
            value={[...scopes]}
            onValueChange={(nextScopes) => {
              setScopeFilters(nextScopes);
            }}
          >
            <SelectTrigger
              aria-label={formatMessage({ id: "search.scope" })}
              render={<PickerTriggerButton className={scopes.length > 0 ? activeFilterClass : undefined} />}
            >
              <AtSign aria-hidden size={14} />
              <span>{getScopeChipLabel(scopes, formatMessage)}</span>
              <SelectIcon>
                <ChevronDown aria-hidden size={12} />
              </SelectIcon>
            </SelectTrigger>
            <SelectContent align="start" portalProps={{ container: filtersPortalRef }}>
              <SelectList>
                <SelectGroup>
                  <SelectGroupLabel>{formatMessage({ id: "search.scope" })}</SelectGroupLabel>
                  <SelectSeparator />
                  {SEARCH_SCOPE_OPTIONS.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      <SelectItemText>{formatMessage({ id: getScopeOptionLabelId(mode) })}</SelectItemText>
                      <SelectItemIndicator />
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectList>
            </SelectContent>
          </Select>

          {channelIdParam ? (() => {
            const ch = channels.find((c) => c.id === channelIdParam) ?? dmChannels.find((c) => c.id === channelIdParam);
            const label = ch ? `#${ch.name}` : `#${formatMessage({ id: "search.channel" })}`;
            return (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => updateSearchParam("channelId", null)}
                className={activeFilterClass}
              >
                <Hash size={12} />
                {label}
                <X size={10} />
              </Button>
            );
          })() : (
            <Combobox<string>
              autoHighlight
              open={openFilterMenu === "channel"}
              onOpenChange={(open) => setOpenFilterMenu(open ? "channel" : null)}
              inputValue={channelFilterQuery}
              items={filteredChannels.map((ch) => ch.id)}
              itemToStringLabel={(id) => channels.find((ch) => ch.id === id)?.name ?? id}
              value={null}
              onInputValueChange={(nextValue, details) => {
                if (details.reason !== "item-press") setChannelFilterQuery(nextValue);
              }}
              onValueChange={(nextValue) => {
                if (nextValue) updateSearchParam("channelId", nextValue);
              }}
            >
              <ComboboxTrigger
                aria-label={formatMessage({ id: "search.openChannelFilter" })}
                render={<PickerTriggerButton />}
              >
                <Hash aria-hidden size={14} />
                <span>{formatMessage({ id: "search.channel" })}</span>
                <ComboboxTriggerIndicator>
                  <ChevronDown aria-hidden size={12} />
                </ComboboxTriggerIndicator>
              </ComboboxTrigger>
              <ComboboxContent
                align="start"
                finalFocus={false}
                initialFocus={false}
                portalProps={{ container: filtersPortalRef }}
              >
                <ComboboxHeader>
                  <ComboboxLabel>{formatMessage({ id: "search.channels" })}</ComboboxLabel>
                </ComboboxHeader>
                <ComboboxSeparator />
                <ComboboxInputGroup>
                  <ComboboxInput
                    aria-label={formatMessage({ id: "search.channels" })}
                    placeholder={formatMessage({ id: "ui.selectionPopover.searchPlaceholder" })}
                    suppressPasswordManager
                  />
                </ComboboxInputGroup>
                <ComboboxList>
                  {filteredChannels.map((ch) => (
                    <ComboboxItem key={ch.id} value={ch.id}>
                      <span className="flex size-5 shrink-0 items-center justify-center">
                        <Hash aria-hidden size={12} />
                      </span>
                      <span>#{ch.name}</span>
                      <ComboboxItemIndicator />
                    </ComboboxItem>
                  ))}
                </ComboboxList>
                <ComboboxEmpty>{formatMessage({ id: "ui.selectionPopover.emptyLabel" })}</ComboboxEmpty>
              </ComboboxContent>
            </Combobox>
          )}

          <Select<SearchTimeRange>
            open={openFilterMenu === "time"}
            onOpenChange={(open) => setOpenFilterMenu(open ? "time" : null)}
            items={SEARCH_TIME_RANGES.map((range) => ({
              label: formatMessage({ id: getTimeRangeLabelId(range) }),
              value: range,
            }))}
            value={timeRange}
            onValueChange={(nextValue) => {
              if (nextValue) {
                updateSearchParam("range", nextValue === "any" ? null : nextValue);
              }
            }}
          >
            <SelectTrigger
              aria-label={formatMessage({ id: "search.time" })}
              render={<PickerTriggerButton className={timeRange !== "any" ? activeFilterClass : undefined} />}
            >
              <CalendarRange aria-hidden size={14} />
              <span>{formatMessage({ id: getTimeRangeLabelId(timeRange) })}</span>
              <SelectIcon>
                <ChevronDown aria-hidden size={12} />
              </SelectIcon>
            </SelectTrigger>
            <SelectContent align="start" portalProps={{ container: filtersPortalRef }}>
              <SelectList>
                <SelectGroup>
                  <SelectGroupLabel>{formatMessage({ id: "search.time" })}</SelectGroupLabel>
                  <SelectSeparator />
                  {SEARCH_TIME_RANGES.map((range) => (
                    <SelectItem key={range} value={range}>
                      <SelectItemText>{formatMessage({ id: getTimeRangeLabelId(range) })}</SelectItemText>
                      <SelectItemIndicator />
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectList>
            </SelectContent>
          </Select>

          {/* Sort chip — same shape as From / Channel / Time per stdrc
              #proj-uiux:c2313b1d msg=da1194bd (2026-05-26): replaces the
              prior Relevant/Recent segmented toggle with a Sort dropdown
              positioned after the existing filter chips. Chip is "active"
              (yellow) when sort != default (relevance), matching the
              time-chip pattern (active when timeRange != "any"). Conceptually
              sort isn't a filter, so it's NOT included in `hasActiveFilters`
              and `clearAllFilters` does NOT reset it — only the visual
              treatment matches. */}
          <Select<SearchSort>
            disabled={!query.trim()}
            open={openFilterMenu === "sort"}
            onOpenChange={(open) => setOpenFilterMenu(open ? "sort" : null)}
            items={SEARCH_SORTS.map((mode) => ({
              label: mode === "relevance" ? formatMessage({ id: "search.sortRelevant" }) : formatMessage({ id: "search.sortRecent" }),
              value: mode,
            }))}
            value={sort}
            onValueChange={(nextValue) => {
              if (nextValue) {
                updateSearchParam("sort", nextValue === "relevance" ? null : nextValue);
              }
            }}
          >
            <SelectTrigger
              aria-label={formatMessage({ id: "search.sort" })}
              data-testid="search-sort-chip"
              render={<PickerTriggerButton className={sort !== "relevance" ? activeFilterClass : undefined} />}
            >
              <ArrowDownUp aria-hidden size={14} />
              <span>{sort === "recent" ? formatMessage({ id: "search.sortRecent" }) : formatMessage({ id: "search.sortRelevant" })}</span>
              <SelectIcon>
                <ChevronDown aria-hidden size={12} />
              </SelectIcon>
            </SelectTrigger>
            <SelectContent align="start" portalProps={{ container: filtersPortalRef }}>
              <SelectList>
                <SelectGroup>
                  <SelectGroupLabel>{formatMessage({ id: "search.sort" })}</SelectGroupLabel>
                  <SelectSeparator />
                  {SEARCH_SORTS.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      <SelectItemText>{mode === "relevance" ? formatMessage({ id: "search.sortRelevant" }) : formatMessage({ id: "search.sortRecent" })}</SelectItemText>
                      <SelectItemIndicator />
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectList>
            </SelectContent>
          </Select>

          {hasActiveFilters && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={clearAllFilters}
            >
              {formatMessage({ id: "search.clearAll" })}
            </Button>
          )}
        </div>
      </SearchShellFilters>
      )}

      <SearchShellViewport className="min-h-0 flex-1 overflow-y-auto">
        {!hasSearchIntent && (overlayHome ? (
          recentConversationEntities.length > 0 ? (
            /* Overlay empty state (task #113, Slack): the conversations you were
               in most recently, as the same destination rows the results use. */
            <div className="p-3" data-testid="search-overlay-recent">
              <SectionEyebrow as="div" className="mb-2 flex items-center gap-1.5 px-1">
                <Clock3 size={12} aria-hidden="true" />
                <span>{formatMessage({ id: "search.overlay.recentConversations" })}</span>
              </SectionEyebrow>
              <SearchResultsList>
                {recentConversationEntities.map((result) => renderEntityResultRow(result, { returnHint: true }))}
              </SearchResultsList>
            </div>
          ) : centeredEmptyState
        ) : !hasSearchHomeContent ? centeredEmptyState : (
          <div className="p-4" data-testid="search-home">
            {searchHistory.length > 0 ? (
              <section className="mb-6" aria-labelledby="search-history-heading">
                <div className="mb-2 flex items-center justify-between gap-3 px-1">
                  <SectionEyebrow as="div" className="flex items-center gap-1.5">
                    <Clock3 size={12} aria-hidden="true" />
                    <span id="search-history-heading">{formatMessage({ id: "search.history" })}</span>
                  </SectionEyebrow>
                  <div className="flex items-center gap-3">
                    {isTouchSearchHome ? (
                      <button
                        type="button"
                        onClick={() => setSearchHistoryEditRequested((editing) => !editing)}
                        className="text-[11px] font-bold text-foreground-muted hover:text-foreground-strong theme-brutal:text-black/45 theme-brutal:hover:text-black"
                        data-testid="search-history-edit-toggle"
                      >
                        {formatMessage({
                          id: searchHistoryEditing ? "search.doneEditHistory" : "search.editHistory",
                        })}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={clearSearchHistory}
                      className="text-[11px] font-bold text-foreground-muted hover:text-foreground-strong theme-brutal:text-black/45 theme-brutal:hover:text-black"
                    >
                      {formatMessage({ id: "search.clearHistory" })}
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2" data-testid="search-history-tags">
                  {searchHistory.map((historyQuery) => (
                    <div
                      key={historyQuery.toLocaleLowerCase()}
                      className="group inline-flex min-w-0 max-w-full items-center border border-line-muted bg-layer-card transition-colors hover:border-line-strong hover:bg-fill-muted focus-within:border-line-strong focus-within:bg-fill-muted theme-brutal:border-black/20 theme-brutal:bg-white theme-brutal:hover:border-black/35 theme-brutal:hover:bg-black/[0.03] theme-brutal:focus-within:border-black/35 theme-brutal:focus-within:bg-black/[0.03]"
                      data-testid="search-history-tag"
                    >
                      <button
                        type="button"
                        onClick={() => chooseSearchHistoryEntry(historyQuery)}
                        className="flex min-w-0 items-center gap-1.5 py-1.5 pl-2.5 pr-1 text-left"
                      >
                        <Clock3 size={12} className="shrink-0 text-foreground-muted theme-brutal:text-black/35" aria-hidden="true" />
                        <span className="truncate text-xs font-medium text-foreground-strong theme-brutal:text-black">{historyQuery}</span>
                      </button>
                      {shouldRenderSearchHistoryRemove({
                        isTouchViewport: isTouchSearchHome,
                        editing: searchHistoryEditing,
                      }) ? (
                        <button
                          type="button"
                          onClick={() => forgetSearchQuery(historyQuery)}
                          className={searchHistoryEditing
                            ? "mr-1 flex size-5 shrink-0 items-center justify-center text-foreground-muted transition-colors hover:bg-fill-muted hover:text-foreground-strong focus-visible:outline focus-visible:outline-1 focus-visible:outline-line-strong theme-brutal:text-black/45 theme-brutal:hover:bg-black/10 theme-brutal:hover:text-black/70 theme-brutal:focus-visible:outline-black/50"
                            : "pointer-events-none mr-1 flex size-5 shrink-0 items-center justify-center text-foreground-placeholder opacity-0 transition-colors transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 hover:bg-fill-muted hover:text-foreground-strong focus:pointer-events-auto focus:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-line-strong theme-brutal:text-black/30 theme-brutal:hover:bg-black/10 theme-brutal:hover:text-black/70 theme-brutal:focus-visible:outline-black/50"}
                          aria-label={formatMessage({ id: "search.removeHistory" }, { query: historyQuery })}
                        >
                          <X size={12} />
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <section aria-labelledby="search-frequent-heading">
              <SectionEyebrow as="div" className="mb-2 flex items-center gap-1.5 px-1">
                <Star size={12} aria-hidden="true" />
                <span id="search-frequent-heading">{formatMessage({ id: "search.frequent" })}</span>
              </SectionEyebrow>
              {frequentSearchEntities.length > 0 ? (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {frequentSearchEntities.map(renderSearchHomeEntity)}
                </div>
              ) : (
                <div className="border border-dashed border-line-muted px-3 py-4 text-xs text-foreground-muted theme-brutal:border-2 theme-brutal:border-black/20 theme-brutal:text-black/40">
                  {formatMessage({ id: "search.frequentEmpty" })}
                </div>
              )}
            </section>
          </div>
        ))}

        {hasSearchIntent && (
          <div className="p-4">
            {showAllResultsAction ? (
              /* Overlay head (task #102, Slack): exact destination first when the
                 query names one, then the "view all results" row. */
              <div className="mb-3 flex flex-col gap-2" data-testid="search-overlay-head">
                {exactDestination ? renderEntityResultRow(exactDestination) : null}
                <SearchEntityResult
                  type="button"
                  data-testid="search-view-all-results"
                  data-active={selectedResultKey === OVERLAY_ALL_RESULTS_KEY ? "true" : undefined}
                  selected={selectedResultKey === OVERLAY_ALL_RESULTS_KEY}
                  onClick={openAllResults}
                >
                  <SearchEntityResultLeading>
                    <SearchEntityResultIcon>
                      <Search size={14} />
                    </SearchEntityResultIcon>
                  </SearchEntityResultLeading>
                  <SearchEntityResultContent>
                    <SearchEntityResultHeader>
                      <SearchEntityResultTitle>
                        {query.trim()
                          ? formatMessage({ id: "search.overlay.searchFor" }, { query: query.trim() })
                          : formatMessage({ id: "search.overlay.viewAllResults" })}
                      </SearchEntityResultTitle>
                    </SearchEntityResultHeader>
                    <SearchEntityResultDescription>
                      {formatMessage({ id: "search.overlay.viewAllResultsHint" })}
                    </SearchEntityResultDescription>
                  </SearchEntityResultContent>
                  <Kbd aria-hidden="true">{RETURN_KEY_GLYPH}</Kbd>
                </SearchEntityResult>
              </div>
            ) : (
              <div className="mb-3 px-1">
                <SearchResultsSummary>
                  {loading ? formatMessage({ id: "search.searching" }) : formatMessage({ id: "search.resultsCount" }, { count: totalResults })}
                </SearchResultsSummary>
              </div>
            )}

            {!loading && totalResults === 0 && !searchError ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <Search size={overlayChrome ? 32 : 48} className="mb-3 text-foreground-muted/30 theme-brutal:text-black/20" />
                <p className="text-sm font-bold text-foreground-muted theme-brutal:text-black/50">
                  {query.trim() ? formatMessage({ id: "search.noResultsForQuery" }, { query: query.trim() }) : formatMessage({ id: "search.noMatchingMessages" })}
                </p>
                <p className="mt-1 text-xs text-foreground-muted/70 theme-brutal:text-black/40">
                  {query.trim() ? formatMessage({ id: "search.tryDifferentKeywords" }) : formatMessage({ id: "search.tryDifferentFilters" })}
                </p>
              </div>
            ) : (
              <>
                {remainingEntityResults.length > 0 && (
                  <SearchResultsSection className="mb-3">
                    <SearchResultsSectionHeading>
                      {formatMessage({ id: "search.serverEntities" })}
                    </SearchResultsSectionHeading>
                    <SearchResultsList
                      ref={entityResultsListRef}
                      data-testid="search-entity-results"
                      className={ENTITY_RESULTS_SCROLL_CLASS}
                    >
                      {remainingEntityResults.map((result) => renderEntityResultRow(result))}
                    </SearchResultsList>
                  </SearchResultsSection>
                )}

                <SearchResultsSection>
                  {((loading && !searchError) || groupedMessageResults.length > 0) && (
                    <SearchResultsSectionHeading>
                      {formatMessage({ id: "search.messages" })}
                    </SearchResultsSectionHeading>
                  )}
                  {showInitialSkeleton ? (
                    <SearchSkeleton />
                  ) : searchError && totalResults === 0 ? (
                    <div className="border border-line-muted bg-layer-card p-4 shadow-raft-sm theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white theme-brutal:shadow-brutal-sm">
                      <div className="mb-2 text-sm font-bold text-foreground-strong theme-brutal:text-black">
                        {formatMessage({
                          id: searchError === "query_too_broad"
                            ? "search.queryTooBroad"
                            : searchError === "search_timeout"
                              ? "search.searchTimedOut"
                              : "search.searchFailed",
                        })}
                      </div>
                      <div className="mb-3 text-xs text-foreground-muted theme-brutal:text-black/60">
                        {formatMessage({
                          id: searchError === "query_too_broad"
                            ? "search.queryTooBroadBody"
                            : searchError === "search_timeout"
                              ? "search.searchTimedOutBody"
                              : "search.searchFailedBody",
                        })}
                      </div>
                      {searchError !== "query_too_broad" ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={retrySearch}
                        >
                          {formatMessage({ id: "search.retry" })}
                        </Button>
                      ) : sort !== "recent" ? (
                        // Recent sort is never rejected as too broad: one click reruns the same search newest first.
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => updateSearchParam("sort", "recent")}
                        >
                          {formatMessage({ id: "search.queryTooBroadSortRecent" })}
                        </Button>
                      ) : null}
                    </div>
                  ) : (
                    <SearchResultsBoundary
                      resetKey={boundaryKey}
                      onRetry={retrySearch}
                    >
                      <SearchResultsList>
                        {groupedMessageResults.map((group) => {
                          if (group.kind === "message") {
                            return renderMessageHit(group.result);
                          }

                          const firstResult = group.results[0];
                          const sourceLabel = firstResult ? getSourceLabel(firstResult) : formatMessage({ id: "search.unknownSource" });
                          const groupHasSelected = group.results.some((r) => selectedResultKey === `message:${r.id}`);

                          return (
                            <SearchThreadResult
                              key={group.key}
                              selected={groupHasSelected}
                            >
                              <SearchThreadResultHeader>
                                <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-foreground-muted theme-brutal:text-black/70">
                                  <Badge appearance="outline">
                                    <ThreadIcon width={11} height={11} />
                                    {formatMessage({ id: "search.threadBadge" })}
                                  </Badge>
                                  <SearchThreadResultMeta>{sourceLabel}</SearchThreadResultMeta>
                                  <span>{formatMessage({ id: "search.hitsCount" }, { count: group.hitCount })}</span>
                                  <SearchThreadResultTimestamp>{(() => {
                                    const parts = getSearchRelativeTimeParts(group.latestCreatedAt);
                                    return parts ? formatRelativeTimeParts(parts.value, parts.unit, intl.locale) : formatMessage({ id: "search.grpUnknownTime" });
                                  })()}</SearchThreadResultTimestamp>
                                </div>
                                <SearchThreadResultTitle>{group.title || formatMessage({ id: "search.grpThreadDiscussion" })}</SearchThreadResultTitle>
                              </SearchThreadResultHeader>
                              <SearchThreadResultMessages>
                                {group.results.map((result) => renderMessageHit(result, true))}
                              </SearchThreadResultMessages>
                            </SearchThreadResult>
                          );
                        })}
                      </SearchResultsList>
                    </SearchResultsBoundary>
                  )}
                </SearchResultsSection>

                {hasMore && !activateResultsInChat && (
                  <div className="flex justify-center py-4">
                    {loadMoreError ? (
                      <div role="alert" className="flex items-center gap-3 border border-line-muted bg-layer-card px-3 py-2 shadow-raft-sm theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white theme-brutal:shadow-brutal-sm">
                        <span className="text-xs font-bold text-foreground-strong theme-brutal:text-black">
                          {formatMessage({ id: "search.loadMoreFailed" })}
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={loadMoreResults}
                          disabled={loadingMore}
                        >
                          {loadingMore ? formatMessage({ id: "common.loading" }) : formatMessage({ id: "search.retry" })}
                        </Button>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={loadMoreResults}
                        disabled={loadingMore}
                      >
                        {loadingMore ? formatMessage({ id: "common.loading" }) : formatMessage({ id: "search.loadMore" })}
                      </Button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </SearchShellViewport>
      {channelContextMenu && createPortal(
        <>
          <DismissBackdrop onDismiss={() => setChannelContextMenu(null)} trapContextMenu />
          <ContextMenuPopup
            ref={(node) => node?.querySelector<HTMLButtonElement>("button")?.focus()}
            role="menu"
            aria-label={formatMessage({ id: "search.channelMenuAria" }, { title: channelContextMenu.result.title })}
            className="fixed z-50 w-48 select-none"
            style={{ left: channelContextMenu.x, top: channelContextMenu.y }}
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setChannelContextMenu(null);
              }
            }}
          >
            <MenuItem
              icon={<FolderOpen size={14} />}
              onClick={() => {
                openEntityResultFromDoubleClick(channelContextMenu.result);
                setChannelContextMenu(null);
              }}
            >
              {formatMessage({ id: "search.open" })}
            </MenuItem>
          </ContextMenuPopup>
        </>,
        document.body,
      )}
    </SearchShellRoot>
  );
}
