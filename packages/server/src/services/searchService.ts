import { performance } from "node:perf_hooks";
import {
  AGENT_API_MESSAGE_SEARCH_DEFAULT_LIMIT,
  AGENT_API_MESSAGE_SEARCH_MAX_LIMIT,
  clearClockTimeout,
  setClockTimeout,
} from "@botiverse/raft-shared";
import { cut } from "jieba-wasm";
import { sql, type SQL } from "drizzle-orm";
import { executeSearchSql, isSearchQueryAbortedError } from "../db/index";
import { addTraceEvent } from "../tracing/semanticTrace";
import { messageSearchErrorTraceAttrs, messageSearchParamTraceAttrs } from "../tracing/messageSearchTrace";
import { traceQuerySpan } from "../tracing/queryTrace";
import { evaluateFeatureFlag, SEARCH_SERVER_TIMELINE_WALK_FEATURE_FLAG_KEY } from "./featureFlagService";
import type { AgentVisibleExternalMessageProvenance } from "@botiverse/raft-shared";

export interface MessageSearchResult {
  id: string;
  seq: number;
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
  externalMessage: AgentVisibleExternalMessageProvenance | null;
  channelName: string;
  channelType: "channel" | "private" | "joint" | "dm" | "thread";
  channelArchivedAt: string | null;
  content: string;
  snippet: string;
  createdAt: string;
}

export type MessageSearchSort = "relevance" | "recent";
/**
 * How a recent-sort text search finds its page. The walk reads messages newest
 * first across every server (idx_messages_created_at) and checks visibility per
 * row, so its cost is the global traffic it passes before LIMIT visible matches:
 * a term that is neither rare nor dense, searched from a server with a small
 * share of the traffic, walks ~160k rows (KBDevTeam user: 464k buffers, 5-6s
 * cold; KBDevTeam agent: canceled). Text matches first costs the term's match
 * set instead, bounded by the same corpus-wide estimate relevance admits; above
 * it the term is dense enough that the walk finds matches quickly.
 */
export type MessageSearchRecentPlan = "walk" | "text_matches_first" | "server_timeline_walk";
export type MessageSearchSenderType = "user" | "agent";

export interface MessageSearchMentionTarget {
  targetType: "user" | "agent";
  targetId: string;
}

/**
 * Relevance search is admitted only when PostgreSQL estimates no more than
 * this many visible, filter-matching FTS candidate rows. The fixed threshold
 * is intentionally 6.1x below the first viewer-scoped production timeout
 * estimate (61,050 rows) while retaining the measured 3,045-row query. It is
 * a conservative admission heuristic, not an exact count or a completion
 * guarantee; statement-timeout remains a typed fail-closed backstop.
 * Keep this value synchronized with manual/agent-knowledge/search.md.
 */
export const MESSAGE_SEARCH_RELEVANCE_ESTIMATED_CANDIDATE_LIMIT = 10_000;
/**
 * Relevance search reads the full-text matches of every server first (the GIN
 * index cannot be narrowed to one server) and only then keeps the visible ones,
 * so it is also admitted only while PostgreSQL estimates at most this many
 * matches across all servers for the text and the message-level filters
 * (sender, sender type, dates, channel). A term absent from the search_vector
 * statistics is always estimated at a fixed selectivity of at most 0.5% of all
 * messages (80,918 of 16.1M rows on prod, 2026-09-29), whatever its real count.
 * So an estimate is only rejected when it is also above
 * MESSAGE_SEARCH_COMMON_TERM_CORPUS_FRACTION of all messages: that keeps rare
 * terms admitted as the corpus grows, and only rejects terms the statistics
 * know to be common.
 * Keep both values synchronized with manual/agent-knowledge/search.md.
 */
export const MESSAGE_SEARCH_RELEVANCE_ESTIMATED_TEXT_MATCH_LIMIT = 200_000;
export const MESSAGE_SEARCH_COMMON_TERM_CORPUS_FRACTION = 0.01;
export const MESSAGE_SEARCH_BREADTH_PROBE_TIMEOUT_MS = 1_000;
export const MESSAGE_SEARCH_QUERY_TOO_BROAD_CODE = "QUERY_TOO_BROAD" as const;
export const MESSAGE_SEARCH_TIMEOUT_CODE = "SEARCH_TIMEOUT" as const;
export const MESSAGE_SEARCH_UNAVAILABLE_CODE = "SEARCH_UNAVAILABLE" as const;
export const MESSAGE_SEARCH_QUERY_TOO_BROAD_MESSAGE =
  "Search query is too broad. Add a channel, sender, or time filter, or use --sort recent.";
export const MESSAGE_SEARCH_TIMEOUT_MESSAGE =
  "Search timed out. Add a channel, sender, or time filter, use --sort recent, or retry.";
export const MESSAGE_SEARCH_UNAVAILABLE_MESSAGE =
  "Search planning is temporarily unavailable. Retry the search.";

export class MessageSearchQueryTooBroadError extends Error {
  readonly code = MESSAGE_SEARCH_QUERY_TOO_BROAD_CODE;
  readonly status = 422;

  constructor() {
    super(MESSAGE_SEARCH_QUERY_TOO_BROAD_MESSAGE);
    this.name = "MessageSearchQueryTooBroadError";
  }
}

export class MessageSearchTimeoutError extends Error {
  readonly code = MESSAGE_SEARCH_TIMEOUT_CODE;
  readonly status = 503;

  constructor() {
    super(MESSAGE_SEARCH_TIMEOUT_MESSAGE);
    this.name = "MessageSearchTimeoutError";
  }
}

export class MessageSearchUnavailableError extends Error {
  readonly code = MESSAGE_SEARCH_UNAVAILABLE_CODE;
  readonly status = 503;

  constructor(options?: ErrorOptions) {
    super(MESSAGE_SEARCH_UNAVAILABLE_MESSAGE, options);
    this.name = "MessageSearchUnavailableError";
  }
}

export type MessageSearchPublicError = MessageSearchQueryTooBroadError | MessageSearchTimeoutError | MessageSearchUnavailableError;

export function isMessageSearchPublicError(error: unknown): error is MessageSearchPublicError {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; status?: unknown };
  return (
    candidate.code === MESSAGE_SEARCH_QUERY_TOO_BROAD_CODE
    || candidate.code === MESSAGE_SEARCH_TIMEOUT_CODE
    || candidate.code === MESSAGE_SEARCH_UNAVAILABLE_CODE
  ) && (candidate.status === 422 || candidate.status === 503);
}

export function isMessageSearchQueryTooBroadError(error: unknown): error is MessageSearchQueryTooBroadError {
  return error instanceof MessageSearchQueryTooBroadError
    || (
      !!error
      && typeof error === "object"
      && (error as { code?: unknown }).code === MESSAGE_SEARCH_QUERY_TOO_BROAD_CODE
    );
}

export function classifyMessageSearchBreadth(estimatedCandidateRows: number): "within_limit" | "over_limit" {
  if (!Number.isInteger(estimatedCandidateRows) || estimatedCandidateRows < 0) {
    throw new Error("Invalid message search planner estimate");
  }
  return estimatedCandidateRows > MESSAGE_SEARCH_RELEVANCE_ESTIMATED_CANDIDATE_LIMIT ? "over_limit" : "within_limit";
}

export function classifyMessageSearchTextMatchBreadth(
  estimatedTextMatchRows: number,
  corpusRows: number,
): "within_limit" | "over_limit" {
  if (!Number.isInteger(estimatedTextMatchRows) || estimatedTextMatchRows < 0 || !Number.isFinite(corpusRows)) {
    throw new Error("Invalid message search planner estimate");
  }
  const limit = Math.max(
    MESSAGE_SEARCH_RELEVANCE_ESTIMATED_TEXT_MATCH_LIMIT,
    Math.max(corpusRows, 0) * MESSAGE_SEARCH_COMMON_TERM_CORPUS_FRACTION,
  );
  return estimatedTextMatchRows > limit ? "over_limit" : "within_limit";
}

const INLINE_CODE_RE = /`([^`]+)`/g;
const FENCED_CODE_RE = /```([\s\S]*?)```/g;
const IMAGE_RE = /!\[([^\]]*)\]\([^)]+\)/g;
const LINK_RE = /\[([^\]]+)\]\([^)]+\)/g;
const URL_RE = /https?:\/\/\S+/g;
const MARKDOWN_DECORATION_RE = /[*_~>|]/g;
const MULTISPACE_RE = /\s+/g;

function normalizeToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed) return null;
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return null;
  return /[A-Za-z]/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

export function preprocessSearchContent(content: string): string {
  return content
    .replace(FENCED_CODE_RE, " $1 ")
    .replace(INLINE_CODE_RE, " $1 ")
    .replace(IMAGE_RE, " $1 ")
    .replace(LINK_RE, " $1 ")
    .replace(URL_RE, " ")
    .replace(MARKDOWN_DECORATION_RE, " ")
    .replace(MULTISPACE_RE, " ")
    .trim();
}

export function tokenizeSearchText(content: string): string[] {
  return cut(preprocessSearchContent(content))
    .map(normalizeToken)
    .filter((token): token is string => !!token);
}

export function buildSearchText(content: string): string {
  return tokenizeSearchText(content).join(" ");
}

function buildSnippet(content: string, queryTokens: string[]): string {
  const compact = content.replace(MULTISPACE_RE, " ").trim();
  if (!compact) return "";

  const lower = compact.toLowerCase();
  let matchIndex = -1;
  let matchToken = "";
  for (const token of queryTokens) {
    const idx = lower.indexOf(token.toLowerCase());
    if (idx >= 0 && (matchIndex === -1 || idx < matchIndex)) {
      matchIndex = idx;
      matchToken = token;
    }
  }

  if (matchIndex === -1) {
    return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
  }

  const start = Math.max(0, matchIndex - 70);
  const end = Math.min(compact.length, matchIndex + matchToken.length + 90);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < compact.length ? "..." : "";
  return `${prefix}${compact.slice(start, end)}${suffix}`;
}

interface SearchRow extends Record<string, unknown> {
  id: string;
  seq: number | string;
  channelId: string;
  threadId: string | null;
  parentMessageId: string | null;
  parentMessageContent: string | null;
  parentChannelId: string;
  parentChannelName: string;
  parentChannelType: "channel" | "private" | "joint" | "dm" | "thread";
  parentChannelArchivedAt: Date | string | null;
  senderId: string;
  senderType: "user" | "agent" | "external_projection";
  senderName: string;
  senderAvatarUrl: string | null;
  externalMessage: AgentVisibleExternalMessageProvenance | null;
  channelName: string;
  channelType: "channel" | "private" | "joint" | "dm" | "thread";
  channelArchivedAt: Date | string | null;
  content: string;
  createdAt: Date | string;
}

interface SearchBreadthProbeRow extends Record<string, unknown> {
  "QUERY PLAN": unknown;
}

type SearchServiceDeps = {
  executeSearchSql: typeof executeSearchSql;
  /** Runtime switch for the server timeline walk (feature flag; absent = off). */
  isServerTimelineWalkEnabled: (serverId: string) => Promise<boolean>;
};

async function isServerTimelineWalkEnabled(serverId: string): Promise<boolean> {
  const evaluation = await evaluateFeatureFlag({ key: SEARCH_SERVER_TIMELINE_WALK_FEATURE_FLAG_KEY, serverId });
  return evaluation.enabled;
}

const defaultSearchServiceDeps: SearchServiceDeps = { executeSearchSql, isServerTimelineWalkEnabled };
let searchServiceDepsOverride: Partial<SearchServiceDeps> | null = null;

function resolveSearchServiceDeps(): SearchServiceDeps {
  return {
    ...defaultSearchServiceDeps,
    ...(searchServiceDepsOverride ?? {}),
  };
}

export function __setSearchServiceDepsForTests(overrides: Partial<SearchServiceDeps>): void {
  searchServiceDepsOverride = overrides;
}

export function __resetSearchServiceDepsForTests(): void {
  searchServiceDepsOverride = null;
}

function parseExplainJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new MessageSearchUnavailableError();
  }
}

/** @internal Strictly project only the root planner row estimate. */
export function readMessageSearchEstimatedCandidateRows(value: unknown): number {
  const parsed = parseExplainJson(value);
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new MessageSearchUnavailableError();
  }
  const explain = parsed[0];
  if (!explain || typeof explain !== "object" || Array.isArray(explain)) {
    throw new MessageSearchUnavailableError();
  }
  const plan = (explain as Record<string, unknown>).Plan;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new MessageSearchUnavailableError();
  }
  const estimatedRows = (plan as Record<string, unknown>)["Plan Rows"];
  if (!Number.isInteger(estimatedRows) || (estimatedRows as number) < 0) {
    throw new MessageSearchUnavailableError();
  }
  return estimatedRows as number;
}

function isPostgresStatementTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === "57014"
    && typeof candidate.message === "string"
    && /statement timeout/i.test(candidate.message);
}

function normalizeCreatedAt(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeNullableTimestamp(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeSeq(value: number | string): number {
  return typeof value === "number" ? value : Number(value);
}

function hasMeaningfulSearchFilter(params: {
  channelId?: string;
  senderId?: string;
  senderType?: MessageSearchSenderType;
  mentionTarget?: MessageSearchMentionTarget;
  after?: Date;
  before?: Date;
  signal?: AbortSignal;
}): boolean {
  return Boolean(params.channelId || params.senderId || params.senderType || params.mentionTarget || params.after || params.before);
}

function buildAnyTokenTsQuery(queryTokens: string[]): SQL | null {
  if (queryTokens.length === 0) return null;
  return queryTokens.slice(1).reduce(
    (acc, token) => sql`${acc} || plainto_tsquery('simple', ${token})`,
    sql`plainto_tsquery('simple', ${queryTokens[0]})`,
  );
}

interface SearchCandidateCtesParams {
  tsQuery: SQL | null;
  sort: MessageSearchSort;
  limit: number;
  offset: number;
  channelFilter: SQL;
  channelScopeFilter: SQL;
  /** The same channel scope as an array, for the GIN-driven text_matches set (see buildSearchFilters). */
  textMatchChannelScopeFilter: SQL;
  senderFilter: SQL;
  senderTypeFilter: SQL;
  mentionTargetFilter: SQL;
  afterFilter: SQL;
  beforeFilter: SQL;
  /**
   * Recent sort with text only: "text_matches_first" collects the text matches
   * first (as relevance does) and orders the visible ones by time; "walk" (the
   * default) walks messages newest first until LIMIT visible matches;
   * "server_timeline_walk" walks only this server's messages newest first
   * (message_server_timeline), for a dense term with no channel filter.
   */
  recentPlan?: MessageSearchRecentPlan;
  /** The searched server: bounds the server timeline walk. */
  serverId?: string;
  /** after/before on message_server_timeline.created_at (the walk's index range). */
  timelineRangeFilter?: SQL;
}

/** @internal Exported so the production query-plan contract can be tested without a database. */
export function buildSearchCandidateCtes(params: SearchCandidateCtesParams): SQL {
  const searchVectorFilter = params.tsQuery ? sql`AND m.search_vector @@ (${params.tsQuery})` : sql``;
  // Recent sort ranks nothing, so either recent plan orders exactly like the
  // walk (created_at, then id) and a page never depends on the plan chosen.
  const matchedCandidateRank = params.tsQuery && params.sort === "relevance"
    ? sql`ts_rank_cd(mm.search_vector, (${params.tsQuery}))`
    : sql`0`;
  const matchedCandidateOrderBy = params.sort === "recent"
    ? sql`mm.created_at DESC, mm.id DESC`
    : sql`${matchedCandidateRank} DESC, mm.created_at DESC, mm.id DESC`;

  if (params.tsQuery && params.sort === "recent" && params.recentPlan === "server_timeline_walk") {
    if (!params.serverId) throw new Error("server_timeline_walk needs the searched serverId");
    // Newest first over this server's messages only (0310 timeline, verified
    // 0 missing / 0 divergent before this plan was switched on), instead of
    // every server's through idx_messages_created_at. Visibility and every
    // filter still read the message itself (m.channel_id, not the timeline's
    // copy), so a stale timeline row can only drop a message, never show one.
    // The text match is written `(... @@ ...) IS TRUE` so it cannot become a
    // GIN index condition: on a server with few visible channels the planner
    // otherwise loops over them and runs BitmapAnd(channel index, GIN) per
    // channel, rescanning the term's whole match set each time (prod
    // 2026-10-03, apache-maka agent, 'means': 2,152 rescans, 27s) instead of
    // walking the timeline. Same rows: IS TRUE only differs from @@ on NULL,
    // which the WHERE clause drops either way.
    return sql`
      search_candidates AS (
        SELECT
          t.message_id AS "id",
          t.created_at AS "createdAt",
          0 AS "searchRank"
        FROM message_server_timeline t
        JOIN messages m
          ON m.id = t.message_id
        JOIN visible_channels vc
          ON vc.id = m.channel_id
        WHERE t.server_id = ${params.serverId}
          ${params.timelineRangeFilter ?? sql``}
          AND (
            m.message_type = 'chat'
            OR EXISTS (
              SELECT 1
              FROM agent_migration_receipt_channels receipt_surface
              WHERE receipt_surface.channel_id = m.channel_id
            )
            OR EXISTS (
              SELECT 1
              FROM agent_private_surfaces private_surface
              WHERE private_surface.channel_id = m.channel_id
            )
          )
          ${params.channelFilter}
          ${params.senderFilter}
          ${params.senderTypeFilter}
          ${params.mentionTargetFilter}
          ${params.afterFilter}
          ${params.beforeFilter}
          AND (m.search_vector @@ (${params.tsQuery})) IS TRUE
        ORDER BY t.created_at DESC, t.message_id DESC
        LIMIT ${params.limit + 1}
        OFFSET ${params.offset}
      )`;
  }

  if (!params.tsQuery || (params.sort === "recent" && params.recentPlan !== "text_matches_first")) {
    return sql`
      search_candidates AS (
        SELECT
          m.id AS "id",
          m.created_at AS "createdAt",
          0 AS "searchRank"
        FROM visible_channels vc
        JOIN messages m
          ON m.channel_id = vc.id
        WHERE (
          m.message_type = 'chat'
          OR EXISTS (
            SELECT 1
            FROM agent_migration_receipt_channels receipt_surface
            WHERE receipt_surface.channel_id = m.channel_id
          )
          OR EXISTS (
            SELECT 1
            FROM agent_private_surfaces private_surface
            WHERE private_surface.channel_id = m.channel_id
          )
        )
          ${params.channelFilter}
          ${params.channelScopeFilter}
          ${params.senderFilter}
          ${params.senderTypeFilter}
          ${params.mentionTargetFilter}
          ${params.afterFilter}
          ${params.beforeFilter}
          ${searchVectorFilter}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ${params.limit + 1}
        OFFSET ${params.offset}
      )`;
  }

  // Relevance (and recent sort on a term with a bounded match set): collect
  // the text matches first, then keep the visible ones.
  // Joining visible_channels to messages instead leaves the join order to the
  // planner, which misestimates the thread arms (every thread in the server
  // joined to a filtered parent set reads as a few dozen rows) and then runs
  // the GIN match once per visible channel: 23k loops, 29s for one Botiverse
  // agent. Here the GIN match runs once, and the planner only picks how to join
  // text_matches to visible_channels, which is cheap either way.
  // text_matches holds only ids from every server (a GIN index cannot be
  // narrowed to one), bounded by the breadth probe's corpus-wide estimate;
  // content and ranking only ever read visible rows.
  return sql`
    text_matches AS MATERIALIZED (
      SELECT
        m.id AS id,
        m.channel_id AS channel_id
      FROM messages m
      WHERE m.search_vector @@ (${params.tsQuery})
        ${params.textMatchChannelScopeFilter}
        ${params.senderFilter}
        ${params.senderTypeFilter}
        ${params.afterFilter}
        ${params.beforeFilter}
    ),
    matched_messages AS MATERIALIZED (
      SELECT
        m.id AS id,
        m.channel_id AS channel_id,
        m.created_at AS created_at,
        m.search_vector AS search_vector
      FROM text_matches tm
      JOIN visible_channels vc
        ON vc.id = tm.channel_id
      JOIN messages m
        ON m.id = tm.id
      WHERE (
        m.message_type = 'chat'
        OR EXISTS (
          SELECT 1
          FROM agent_migration_receipt_channels receipt_surface
          WHERE receipt_surface.channel_id = m.channel_id
        )
        OR EXISTS (
          SELECT 1
          FROM agent_private_surfaces private_surface
          WHERE private_surface.channel_id = m.channel_id
        )
      )
        ${params.channelFilter}
        ${params.mentionTargetFilter}
    ),
    search_candidates AS (
      SELECT
        mm.id AS "id",
        mm.created_at AS "createdAt",
        ${matchedCandidateRank} AS "searchRank"
      FROM matched_messages mm
      ORDER BY ${matchedCandidateOrderBy}
      LIMIT ${params.limit + 1}
      OFFSET ${params.offset}
    )`;
}


export interface MessageSearchStatementParams {
  serverId: string;
  channelId?: string;
  senderId?: string;
  senderType?: MessageSearchSenderType;
  mentionTarget?: MessageSearchMentionTarget;
  after?: Date;
  before?: Date;
  sort: MessageSearchSort;
  recentPlan?: MessageSearchRecentPlan;
  limit: number;
  offset: number;
}

function buildSearchFilters(params: MessageSearchStatementParams) {
  const channelFilter = params.channelId
    ? sql`AND (m.channel_id = ${params.channelId} OR vc.parent_channel_id = ${params.channelId})`
    : sql``;
  // The channel filter without visibility: the channel and its live threads,
  // through idx_channels_thread_parent_channel. A superset of what
  // channelFilter passes (both visibility builders only admit live threads),
  // so messages can be narrowed to the filtered channel before visibility is
  // joined instead of scanning every visible channel.
  const channelScopeFilter = params.channelId
    ? sql`AND m.channel_id IN (
        SELECT ${params.channelId}::uuid
        UNION ALL
        SELECT scoped_thread.id
        FROM channels scoped_thread
        WHERE scoped_thread.parent_channel_id = ${params.channelId}
          AND scoped_thread.type = 'thread'
          AND scoped_thread.deleted_at IS NULL
      )`
    : sql``;
  // The same scope as an array, computed once (an InitPlan) before the text
  // match. As IN (subquery) the planner may instead run the GIN match once per
  // scoped channel (BitmapAnd with the channel index, one GIN rescan per thread)
  // whenever the term's estimate is small: 3,241 rescans, 4.8s for a 13k-match
  // term on a channel with 3,240 threads. The walk keeps the IN form: there the
  // scope is a per-row filter, which IN hashes and a parameter array does not.
  const textMatchChannelScopeFilter = params.channelId
    ? sql`AND m.channel_id = ANY(ARRAY(
        SELECT ${params.channelId}::uuid
        UNION ALL
        SELECT scoped_thread.id
        FROM channels scoped_thread
        WHERE scoped_thread.parent_channel_id = ${params.channelId}
          AND scoped_thread.type = 'thread'
          AND scoped_thread.deleted_at IS NULL
      ))`
    : sql``;
  const senderFilter = params.senderId
    ? sql`AND m.sender_id = ${params.senderId}`
    : sql``;
  const senderTypeFilter = params.senderType
    ? sql`AND m.sender_type = ${params.senderType}`
    : sql``;
  const mentionTargetFilter = params.mentionTarget
    ? sql`AND EXISTS (
        SELECT 1
        FROM message_mentions mm
        WHERE mm.message_id = m.id
          AND mm.server_id = ${params.serverId}
          AND mm.target_type = ${params.mentionTarget.targetType}
          AND mm.target_id = ${params.mentionTarget.targetId}
      )`
    : sql``;
  const afterFilter = params.after
    ? sql`AND m.created_at >= ${params.after}`
    : sql``;
  const beforeFilter = params.before
    ? sql`AND m.created_at <= ${params.before}`
    : sql``;
  const timelineRangeFilter = sql`${params.after ? sql`AND t.created_at >= ${params.after}` : sql``} ${params.before ? sql`AND t.created_at <= ${params.before}` : sql``}`;
  return { channelFilter, channelScopeFilter, textMatchChannelScopeFilter, senderFilter, senderTypeFilter, mentionTargetFilter, afterFilter, beforeFilter, timelineRangeFilter };
}

/**
 * @internal Single source of the full search statement: the service executes
 * exactly this, and the real-PG filter-only plan-shape contract EXPLAINs
 * exactly this — no drifting SQL copy in tests. Composes the same
 * buildSearchCandidateCtes the breadth-gated relevance path uses.
 */
export function buildMessageSearchStatement(
  visibleChannelsSql: SQL,
  params: MessageSearchStatementParams,
  tsQuery: SQL | null,
): SQL {
  const { channelFilter, channelScopeFilter, textMatchChannelScopeFilter, senderFilter, senderTypeFilter, mentionTargetFilter, afterFilter, beforeFilter, timelineRangeFilter } = buildSearchFilters(params);
  const finalOrderBy = !tsQuery
    ? sql`sc."createdAt" DESC, sc."id" DESC`
    : params.sort === "recent"
      ? sql`sc."createdAt" DESC, sc."searchRank" DESC, sc."id" DESC`
      : sql`sc."searchRank" DESC, sc."createdAt" DESC, sc."id" DESC`;
  const candidateCtes = buildSearchCandidateCtes({
    tsQuery,
    sort: params.sort,
    recentPlan: params.recentPlan,
    serverId: params.serverId,
    timelineRangeFilter,
    limit: params.limit,
    offset: params.offset,
    channelFilter,
    channelScopeFilter,
    textMatchChannelScopeFilter,
    senderFilter,
    senderTypeFilter,
    mentionTargetFilter,
    afterFilter,
    beforeFilter,
  });
  return sql`
        -- Keep the full-text/access pass narrow; enrich parent and sender fields
        -- only after LIMIT so profile joins do not run across every candidate hit.
        WITH visible_channels AS (
          ${visibleChannelsSql}
        ),
        ${candidateCtes}
        SELECT
          m.id AS "id",
          m.seq AS "seq",
          m.channel_id AS "channelId",
          CASE
            WHEN c.type = 'thread' THEN c.id::text
            ELSE m.thread_id
          END AS "threadId",
          c.parent_message_id AS "parentMessageId",
          pm.content AS "parentMessageContent",
          COALESCE(pc.id, c.id) AS "parentChannelId",
          COALESCE(pc.name, c.name) AS "parentChannelName",
          COALESCE(pc.type, c.type) AS "parentChannelType",
          COALESCE(pc.archived_at, c.archived_at) AS "parentChannelArchivedAt",
          m.sender_id AS "senderId",
          m.sender_type AS "senderType",
          COALESCE(emaf.display_name, NULLIF(a.display_name, ''), a.name, NULLIF(u.display_name, ''), u.name, 'Unknown') AS "senderName",
          CASE
            WHEN epa.state = 'active'
             AND epa.public_url = emaf.avatar_url
             AND epa.source_digest = emaf.avatar_digest
            THEN epa.public_url
            ELSE NULL
          END AS "senderAvatarUrl",
          CASE WHEN emaf.message_id IS NOT NULL THEN jsonb_build_object(
            'schema', 'external-message-provenance.v1',
            'provider', emaf.provider,
            'workspace_id', emaf.workspace_id,
            'conversation_id', emaf.external_conversation_id,
            'message_id', emaf.external_message_id,
            'actor_id', emaf.external_actor_id,
            'actor_kind', emaf.actor_kind,
            'projection_id', emaf.projection_id
          ) ELSE NULL END AS "externalMessage",
          c.name AS "channelName",
          c.type AS "channelType",
          c.archived_at AS "channelArchivedAt",
          m.content AS "content",
          m.created_at AS "createdAt"
        FROM search_candidates sc
        JOIN messages m
          ON m.id = sc.id
        JOIN channels c ON c.id = m.channel_id
        LEFT JOIN messages pm
          ON c.type = 'thread'
         AND pm.id = c.parent_message_id
        LEFT JOIN channels pc
          ON pc.id = pm.channel_id
        LEFT JOIN agents a
          ON m.sender_type = 'agent'
         AND a.id = NULLIF(m.sender_id, 'system')::uuid
        LEFT JOIN users u
          ON m.sender_type = 'user'
         AND u.id = NULLIF(m.sender_id, 'system')::uuid
        LEFT JOIN external_message_author_facts emaf
          ON m.sender_type = 'external_projection'
         AND emaf.message_id = m.id
        LEFT JOIN external_projection_avatar_artifacts epa
          ON epa.id = emaf.avatar_artifact_id
        ORDER BY ${finalOrderBy}
      `;
}

interface SearchBreadthProbeParams {
  visibleChannelsSql: SQL;
  tsQuery: SQL;
  channelFilter: SQL;
  senderFilter: SQL;
  senderTypeFilter: SQL;
  mentionTargetFilter: SQL;
  afterFilter: SQL;
  beforeFilter: SQL;
}

interface SearchTextMatchProbeParams {
  tsQuery: SQL;
  channelScopeFilter: SQL;
  senderFilter: SQL;
  senderTypeFilter: SQL;
  afterFilter: SQL;
  beforeFilter: SQL;
}

/**
 * @internal The estimate for the relevance statement's text_matches set: the
 * same predicate over every server, planned but not executed.
 */
export function buildMessageSearchTextMatchProbeSql(params: SearchTextMatchProbeParams): SQL {
  return sql`
    EXPLAIN (FORMAT JSON)
    SELECT m.id
    FROM messages m
    WHERE m.search_vector @@ (${params.tsQuery})
      ${params.channelScopeFilter}
      ${params.senderFilter}
      ${params.senderTypeFilter}
      ${params.afterFilter}
      ${params.beforeFilter}
  `;
}

/** @internal Exported so the planner-admission contract can be verified without production data. */
export function buildMessageSearchBreadthProbeSql(params: SearchBreadthProbeParams): SQL {
  return sql`
    EXPLAIN (FORMAT JSON)
    WITH visible_channels AS (
      ${params.visibleChannelsSql}
    )
    SELECT m.id
    FROM visible_channels vc
    JOIN messages m
      ON m.channel_id = vc.id
    WHERE (
      m.message_type = 'chat'
      OR EXISTS (
        SELECT 1
        FROM agent_migration_receipt_channels receipt_surface
        WHERE receipt_surface.channel_id = m.channel_id
      )
      OR EXISTS (
        SELECT 1
        FROM agent_private_surfaces private_surface
        WHERE private_surface.channel_id = m.channel_id
      )
    )
      ${params.channelFilter}
      ${params.senderFilter}
      ${params.senderTypeFilter}
      ${params.mentionTargetFilter}
      ${params.afterFilter}
      ${params.beforeFilter}
      AND m.search_vector @@ (${params.tsQuery})
  `;
}

function createBreadthProbeAbort(parentSignal?: AbortSignal): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setClockTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Message search breadth probe timed out"));
  }, MESSAGE_SEARCH_BREADTH_PROBE_TIMEOUT_MS);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearClockTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

async function searchMessages(
  visibleChannelsSql: SQL,
  membershipParams: {
    serverId: string;
    channelId?: string;
    senderId?: string;
    senderType?: MessageSearchSenderType;
    mentionTarget?: MessageSearchMentionTarget;
    after?: Date;
    before?: Date;
    sort: MessageSearchSort;
    limit: number;
    offset: number;
    signal?: AbortSignal;
  },
  query: string,
  /**
   * The same visible set, shaped for the recent walk: that plan checks
   * visibility once per message it passes (newest first), so the set must be
   * a per-channel primary-key lookup the planner can memoize, not a UNION the
   * planner re-runs per row. Defaults to visibleChannelsSql.
   */
  walkVisibleChannelsSql: SQL = visibleChannelsSql,
): Promise<{ results: MessageSearchResult[]; hasMore: boolean }> {
  const queryTokens = tokenizeSearchText(query);
  const searchText = queryTokens.join(" ");
  const hasSearchText = Boolean(searchText);
  if (!hasSearchText && !hasMeaningfulSearchFilter(membershipParams)) {
    return { results: [], hasMore: false };
  }

  const strictTsQuery = hasSearchText ? sql`plainto_tsquery('simple', ${searchText})` : null;
  const fallbackTsQuery = hasSearchText && queryTokens.length > 1 ? buildAnyTokenTsQuery(queryTokens) : null;
  const { channelFilter, channelScopeFilter, senderFilter, senderTypeFilter, mentionTargetFilter, afterFilter, beforeFilter } = buildSearchFilters(membershipParams);

  const deps = resolveSearchServiceDeps();
  const queryStart = performance.now();
  let rows: { rows: SearchRow[] };
  let fallbackUsed = false;
  // Planner estimate of the text matches over every server (not executed),
  // classified against the corpus-wide cap relevance admits.
  const probeTextMatchBreadth = async (tsQuery: SQL, signal: AbortSignal): Promise<"within_limit" | "over_limit"> => {
    const textMatch = await traceQuerySpan({
      queryName: "messages.search.text_match_breadth",
      phase: "text_match_breadth_probe",
      dbSystem: "postgresql",
      attrs: {
        search_text_present: true,
        query_plan_shape: "fts_explain_estimate",
        estimated_text_match_limit: MESSAGE_SEARCH_RELEVANCE_ESTIMATED_TEXT_MATCH_LIMIT,
        probe_timeout_ms: MESSAGE_SEARCH_BREADTH_PROBE_TIMEOUT_MS,
      },
      successAttrs: (probe) => ({
        estimated_text_match_rows: probe.estimatedTextMatchRows,
        corpus_rows: probe.corpusRows,
      }),
    }, async () => {
      const [explain, corpus] = await Promise.all([
        deps.executeSearchSql<SearchBreadthProbeRow>(buildMessageSearchTextMatchProbeSql({
          tsQuery,
          channelScopeFilter,
          senderFilter,
          senderTypeFilter,
          afterFilter,
          beforeFilter,
        }), { signal }),
        deps.executeSearchSql<{ corpus_rows: unknown }>(
          sql`SELECT reltuples::float8 AS corpus_rows FROM pg_class WHERE oid = 'messages'::regclass`,
          { signal },
        ),
      ]);
      if (explain.rows.length !== 1 || corpus.rows.length !== 1) throw new MessageSearchUnavailableError();
      return {
        estimatedTextMatchRows: readMessageSearchEstimatedCandidateRows(explain.rows[0]?.["QUERY PLAN"]),
        corpusRows: Number(corpus.rows[0]?.corpus_rows),
      };
    });
    return classifyMessageSearchTextMatchBreadth(textMatch.estimatedTextMatchRows, textMatch.corpusRows);
  };
  const probeSearchBreadth = async (tsQuery: SQL): Promise<"within_limit" | "over_limit"> => {
    const abort = createBreadthProbeAbort(membershipParams.signal);
    try {
      const result = await traceQuerySpan({
        queryName: "messages.search.breadth",
        phase: "candidate_breadth_probe",
        dbSystem: "postgresql",
        attrs: {
          ...messageSearchParamTraceAttrs({
            query,
            channelId: membershipParams.channelId,
            senderId: membershipParams.senderId,
            after: membershipParams.after,
            before: membershipParams.before,
            sort: membershipParams.sort,
            limit: membershipParams.limit,
            offset: membershipParams.offset,
          }),
          search_text_present: true,
          query_plan_shape: "fts_explain_estimate",
          estimated_candidate_limit: MESSAGE_SEARCH_RELEVANCE_ESTIMATED_CANDIDATE_LIMIT,
          probe_timeout_ms: MESSAGE_SEARCH_BREADTH_PROBE_TIMEOUT_MS,
        },
        successAttrs: (probeResult) => ({
          estimated_candidate_rows: readMessageSearchEstimatedCandidateRows(probeResult.rows[0]?.["QUERY PLAN"]),
        }),
      }, () => deps.executeSearchSql<SearchBreadthProbeRow>(buildMessageSearchBreadthProbeSql({
        visibleChannelsSql,
        tsQuery,
        channelFilter,
        senderFilter,
        senderTypeFilter,
        mentionTargetFilter,
        afterFilter,
        beforeFilter,
      }), { signal: abort.signal }));
      if (result.rows.length !== 1) throw new MessageSearchUnavailableError();
      if (classifyMessageSearchBreadth(readMessageSearchEstimatedCandidateRows(result.rows[0]?.["QUERY PLAN"])) === "over_limit") {
        return "over_limit";
      }
      // The relevance statement reads the text matches of every server before
      // visibility (see buildSearchCandidateCtes), so bound that set too.
      return await probeTextMatchBreadth(tsQuery, abort.signal);
    } catch (error) {
      if (abort.didTimeout() && !membershipParams.signal?.aborted && isSearchQueryAbortedError(error)) {
        throw new MessageSearchTimeoutError();
      }
      if (isPostgresStatementTimeout(error)) throw new MessageSearchTimeoutError();
      if (isMessageSearchPublicError(error) || isSearchQueryAbortedError(error)) throw error;
      throw new MessageSearchUnavailableError({ cause: error });
    } finally {
      abort.cleanup();
    }
  };
  // Recent sort never rejects: a term within the corpus-wide cap takes text
  // matches first, a denser one (or a failed probe) walks newest first.
  const chooseRecentPlan = async (tsQuery: SQL): Promise<MessageSearchRecentPlan> => {
    const abort = createBreadthProbeAbort(membershipParams.signal);
    try {
      return await probeTextMatchBreadth(tsQuery, abort.signal) === "within_limit" ? "text_matches_first" : "walk";
    } catch (error) {
      if (membershipParams.signal?.aborted) throw error;
      return "walk";
    } finally {
      abort.cleanup();
    }
  };
  const executeSearch = async (tsQuery: SQL | null, mode: "strict_all_terms" | "relaxed_any_term") => {
    const breadth = tsQuery && membershipParams.sort === "relevance"
      ? await probeSearchBreadth(tsQuery)
      : "within_limit";
    if (breadth === "over_limit") {
      throw new MessageSearchQueryTooBroadError();
    }
    const chosenRecentPlan: MessageSearchRecentPlan | undefined = tsQuery && membershipParams.sort === "recent"
      ? await chooseRecentPlan(tsQuery)
      : undefined;
    // A dense term with no channel filter walks this server's timeline (when
    // the flag is on); with a channel filter the walk is already narrowed to
    // that channel. The flag is read only for that case, and a failed read
    // keeps the global walk.
    const recentPlan: MessageSearchRecentPlan | undefined = chosenRecentPlan === "walk"
      && !membershipParams.channelId
      && await deps.isServerTimelineWalkEnabled(membershipParams.serverId).catch(() => false)
      ? "server_timeline_walk"
      : chosenRecentPlan;
    return traceQuerySpan({
      queryName: "messages.search",
      phase: "visibility_candidates_enrich",
      dbSystem: "postgresql",
      attrs: {
        ...messageSearchParamTraceAttrs({
          query,
          channelId: membershipParams.channelId,
          senderId: membershipParams.senderId,
          after: membershipParams.after,
          before: membershipParams.before,
          sort: membershipParams.sort,
          limit: membershipParams.limit,
          offset: membershipParams.offset,
        }),
        search_text_present: hasSearchText,
        query_match_mode: mode,
        query_plan_shape: !tsQuery
          ? "page_first_single_statement"
          : recentPlan === "server_timeline_walk"
            ? "fts_recent_server_timeline"
            : recentPlan === "walk"
              ? "fts_recent_page_first"
              : recentPlan === "text_matches_first"
                ? "fts_recent_text_matches_first"
                : "fts_text_matches_first",
      },
      successAttrs: (result) => ({ row_count: result.rows.length }),
    }, () => deps.executeSearchSql<SearchRow>(
      buildMessageSearchStatement(
        recentPlan === "walk" || recentPlan === "server_timeline_walk" ? walkVisibleChannelsSql : visibleChannelsSql,
        { ...membershipParams, recentPlan },
        tsQuery,
      ),
      { signal: membershipParams.signal },
    ));
  };
  try {
    rows = await executeSearch(strictTsQuery, "strict_all_terms");
    if (rows.rows.length === 0 && fallbackTsQuery && membershipParams.offset === 0) {
      fallbackUsed = true;
      rows = await executeSearch(fallbackTsQuery, "relaxed_any_term");
    }
  } catch (error) {
    const aborted = isSearchQueryAbortedError(error);
    const publicError = isPostgresStatementTimeout(error)
      ? new MessageSearchTimeoutError()
      : error;
    addTraceEvent("message_search.query.failed", {
      ...messageSearchParamTraceAttrs({
        query,
        channelId: membershipParams.channelId,
        senderId: membershipParams.senderId,
        senderType: membershipParams.senderType,
        mentionTarget: membershipParams.mentionTarget ? "self" : undefined,
        after: membershipParams.after,
        before: membershipParams.before,
        sort: membershipParams.sort,
        limit: membershipParams.limit,
        offset: membershipParams.offset,
      }),
      outcome: aborted ? "canceled" : "error",
      reason: aborted ? "client_aborted" : "query_failed",
      query_name: "messages.search",
      duration_ms: Math.round(performance.now() - queryStart),
      search_text_present: hasSearchText,
      query_match_mode: fallbackUsed ? "relaxed_any_term" : "strict_all_terms",
      ...messageSearchErrorTraceAttrs(error, { query }),
    });
    throw publicError;
  }

  const overFetched = rows.rows.length > membershipParams.limit;
  const hasMore = !fallbackUsed && overFetched;
  const visibleRows = overFetched ? rows.rows.slice(0, membershipParams.limit) : rows.rows;
  if (visibleRows.some((row) => row.senderType === "external_projection" && !row.externalMessage)) {
    throw new Error("External projection search row is missing immutable author fact");
  }
  addTraceEvent("message_search.query.finished", {
    ...messageSearchParamTraceAttrs({
      query,
      channelId: membershipParams.channelId,
      senderId: membershipParams.senderId,
      senderType: membershipParams.senderType,
      mentionTarget: membershipParams.mentionTarget ? "self" : undefined,
      after: membershipParams.after,
      before: membershipParams.before,
      sort: membershipParams.sort,
      limit: membershipParams.limit,
      offset: membershipParams.offset,
    }),
    outcome: "success",
    reason: "query_completed",
    query_name: "messages.search",
    duration_ms: Math.round(performance.now() - queryStart),
    search_text_present: hasSearchText,
    query_match_mode: fallbackUsed ? "relaxed_any_term" : "strict_all_terms",
    row_count: rows.rows.length,
    visible_row_count: visibleRows.length,
    has_more: hasMore,
  });

  return {
    hasMore,
    results: visibleRows.map((row) => ({
      ...row,
      seq: normalizeSeq(row.seq),
      snippet: buildSnippet(row.content, queryTokens),
      createdAt: normalizeCreatedAt(row.createdAt),
      channelArchivedAt: normalizeNullableTimestamp(row.channelArchivedAt),
      parentChannelArchivedAt: normalizeNullableTimestamp(row.parentChannelArchivedAt),
    })),
  };
}

/**
 * Channels one human can search. A thread's parent channel comes from
 * channels.parent_channel_id (0297: trigger-derived from the parent message,
 * NULL when the thread has none), so resolving visibility never reads
 * messages. The parent must be in this server: a thread whose parent message
 * lives in another server's channel is not visible here.
 */
export function buildUserVisibleChannelsSql(params: {
  serverId: string;
  userId: string;
  allowedRootChannelIds?: readonly string[];
}): SQL {
  const explicitRootFilter = params.allowedRootChannelIds
    ? params.allowedRootChannelIds.length === 0
      ? sql`FALSE`
      : sql`COALESCE(parent_channels.id, visible_channels.id) IN (${sql.join(params.allowedRootChannelIds.map((id) => sql`${id}`), sql`, `)})`
    : null;
  return sql`
    SELECT
      visible_channels.id AS id,
      COALESCE(parent_channels.id, visible_channels.id) AS parent_channel_id
    FROM channels visible_channels
    LEFT JOIN channels parent_channels
      ON visible_channels.type = 'thread'
     AND parent_channels.id = visible_channels.parent_channel_id
     AND parent_channels.server_id = visible_channels.server_id
    JOIN server_members sm
      ON sm.server_id = visible_channels.server_id
     AND sm.user_id = ${params.userId}
    LEFT JOIN channel_humans ch
      ON ch.channel_id = visible_channels.id
     AND ch.user_id = ${params.userId}
    LEFT JOIN channel_humans pch
      ON pch.channel_id = parent_channels.id
     AND pch.user_id = ${params.userId}
    WHERE visible_channels.server_id = ${params.serverId}
      AND visible_channels.deleted_at IS NULL
      AND parent_channels.deleted_at IS NULL
      AND ${explicitRootFilter ?? sql`(
        visible_channels.type = 'channel'
        OR (visible_channels.type IN ('private', 'dm') AND ch.user_id IS NOT NULL)
        OR (
          visible_channels.type = 'thread'
          AND (
            parent_channels.type = 'channel'
            OR (parent_channels.type IN ('private', 'dm') AND pch.user_id IS NOT NULL)
          )
        )
      )`}
  `;
}

/**
 * Channels one agent can search: public channels, its private/DM channels, and
 * the live threads under each, found from the parent side through
 * idx_channels_thread_parent_channel (parent_channel_id, id), so the cost
 * follows the visible parent channels, not every thread in the server, and
 * never reads messages.
 */
export function buildAgentVisibleChannelsSql(params: {
  serverId: string;
  agentId: string;
}): SQL {
  return sql`
    SELECT
      public_channels.id AS id,
      public_channels.id AS parent_channel_id
    FROM channels public_channels
    WHERE public_channels.server_id = ${params.serverId}
      AND public_channels.type = 'channel'
      AND public_channels.deleted_at IS NULL

    UNION ALL

    SELECT
      member_channels.id AS id,
      member_channels.id AS parent_channel_id
    FROM channel_agents ca
    JOIN channels member_channels
      ON member_channels.id = ca.channel_id
    WHERE ca.agent_id = ${params.agentId}
      AND member_channels.server_id = ${params.serverId}
      AND member_channels.type IN ('private', 'dm')
      AND member_channels.deleted_at IS NULL

    UNION ALL

    SELECT
      tc.id AS id,
      pc.id AS parent_channel_id
    FROM channels pc
    JOIN channels tc
      ON tc.parent_channel_id = pc.id
     AND tc.type = 'thread'
     AND tc.deleted_at IS NULL
    WHERE pc.server_id = ${params.serverId}
      AND pc.type = 'channel'
      AND pc.deleted_at IS NULL
      AND tc.server_id = ${params.serverId}

    UNION ALL

    SELECT
      tc.id AS id,
      pc.id AS parent_channel_id
    FROM channel_agents pca
    JOIN channels pc
      ON pc.id = pca.channel_id
    JOIN channels tc
      ON tc.parent_channel_id = pc.id
     AND tc.type = 'thread'
     AND tc.deleted_at IS NULL
    WHERE pca.agent_id = ${params.agentId}
      AND pc.server_id = ${params.serverId}
      AND pc.type IN ('private', 'dm')
      AND pc.deleted_at IS NULL
      AND tc.server_id = ${params.serverId}
  `;
}

/**
 * The agent's visible channels (same set as buildAgentVisibleChannelsSql) as
 * one join from the channel side, like buildUserVisibleChannelsSql: joined to
 * messages, it resolves each message's channel by primary key. For the recent
 * walk only; the UNION form stays the one to enumerate the whole set.
 */
export function buildAgentVisibleChannelsRowCheckSql(params: {
  serverId: string;
  agentId: string;
}): SQL {
  return sql`
    SELECT
      visible_channels.id AS id,
      COALESCE(parent_channels.id, visible_channels.id) AS parent_channel_id
    FROM channels visible_channels
    LEFT JOIN channels parent_channels
      ON visible_channels.type = 'thread'
     AND parent_channels.id = visible_channels.parent_channel_id
     AND parent_channels.server_id = visible_channels.server_id
    LEFT JOIN channel_agents ca
      ON ca.channel_id = visible_channels.id
     AND ca.agent_id = ${params.agentId}
    LEFT JOIN channel_agents pca
      ON pca.channel_id = parent_channels.id
     AND pca.agent_id = ${params.agentId}
    WHERE visible_channels.server_id = ${params.serverId}
      AND visible_channels.deleted_at IS NULL
      AND parent_channels.deleted_at IS NULL
      AND (
        visible_channels.type = 'channel'
        OR (visible_channels.type IN ('private', 'dm') AND ca.agent_id IS NOT NULL)
        OR (
          visible_channels.type = 'thread'
          AND (
            parent_channels.type = 'channel'
            OR (parent_channels.type IN ('private', 'dm') AND pca.agent_id IS NOT NULL)
          )
        )
      )
  `;
}

export async function searchMessagesForUser(params: {
  serverId: string;
  userId: string;
  query: string;
  channelId?: string;
  senderId?: string;
  senderType?: MessageSearchSenderType;
  mentionTarget?: MessageSearchMentionTarget;
  after?: Date;
  before?: Date;
  sort?: MessageSearchSort;
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
  allowedRootChannelIds?: readonly string[];
}): Promise<{ results: MessageSearchResult[]; hasMore: boolean }> {
  return searchMessages(
    buildUserVisibleChannelsSql({
      serverId: params.serverId,
      userId: params.userId,
      allowedRootChannelIds: params.allowedRootChannelIds,
    }),
    {
      serverId: params.serverId,
      channelId: params.channelId,
      senderId: params.senderId,
      senderType: params.senderType,
      mentionTarget: params.mentionTarget,
      after: params.after,
      before: params.before,
      sort: params.sort ?? "relevance",
      limit: Math.min(
        params.limit ?? AGENT_API_MESSAGE_SEARCH_DEFAULT_LIMIT,
        AGENT_API_MESSAGE_SEARCH_MAX_LIMIT,
      ),
      offset: Math.max(params.offset ?? 0, 0),
      signal: params.signal,
    },
    params.query,
  );
}

export async function searchMessagesForAgent(params: {
  serverId: string;
  agentId: string;
  query: string;
  channelId?: string;
  senderId?: string;
  senderType?: MessageSearchSenderType;
  mentionTarget?: MessageSearchMentionTarget;
  after?: Date;
  before?: Date;
  sort?: MessageSearchSort;
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
}): Promise<{ results: MessageSearchResult[]; hasMore: boolean }> {
  return searchMessages(
    buildAgentVisibleChannelsSql({
      serverId: params.serverId,
      agentId: params.agentId,
    }),
    {
      serverId: params.serverId,
      channelId: params.channelId,
      senderId: params.senderId,
      senderType: params.senderType,
      mentionTarget: params.mentionTarget,
      after: params.after,
      before: params.before,
      sort: params.sort ?? "relevance",
      limit: Math.min(
        params.limit ?? AGENT_API_MESSAGE_SEARCH_DEFAULT_LIMIT,
        AGENT_API_MESSAGE_SEARCH_MAX_LIMIT,
      ),
      offset: Math.max(params.offset ?? 0, 0),
      signal: params.signal,
    },
    params.query,
    buildAgentVisibleChannelsRowCheckSql({
      serverId: params.serverId,
      agentId: params.agentId,
    }),
  );
}

export { isSearchQueryAbortedError };
