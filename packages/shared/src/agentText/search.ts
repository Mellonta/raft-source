// Canonical search-result text for agent-facing output (moved verbatim from
// the CLI's commands/message/_format.ts; the CLI wraps this in its axSurface
// registration and pins the bytes with its snapshot tests).

import { AGENT_API_MESSAGE_SEARCH_DEFAULT_LIMIT, AGENT_API_MESSAGE_SEARCH_MAX_LIMIT } from "../agentApiContract";
import { formatAgentTaskCurrentProjection, type AgentMessageTaskCurrentProjectionLike } from "../agentMessageText";
import { formatHintFlag, type RaftHintStyle } from "../agentOps/hint";

export interface AgentSearchResultLike {
  id: string;
  seq: number;
  createdAt?: string;
  channelType?: string;
  channelName?: string;
  parentChannelType?: string;
  parentChannelName?: string;
  senderName?: string;
  senderType?: string;
  content?: string;
  snippet?: string;
  threadId?: string;
  taskStatus?: string | null;
  taskNumber?: number | null;
  taskCurrentProjection?: AgentMessageTaskCurrentProjectionLike | null;
  [key: string]: unknown;
}

export interface AgentSearchData {
  results?: AgentSearchResultLike[];
  /** Required by the contract; optional here because an older Server can omit it (third state: unknown). */
  hasMore?: boolean;
}

/** Local wall-clock rendering with offset, as the CLI prints search hit times. */
export function formatLocalTimeWithOffset(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${offset}`;
}

function renderSearchSource(result: AgentSearchResultLike): string {
  if (result.channelType === "thread") {
    const shortId = typeof result.channelName === "string" && result.channelName.startsWith("thread-")
      ? result.channelName.slice(7)
      : (typeof result.threadId === "string" && result.threadId ? result.threadId.slice(0, 8) : result.channelName);
    if (result.parentChannelType === "dm") {
      return `dm:${neutralizeAgentRaftRefLiterals(result.parentChannelName ?? "unknown")}:${shortId}`;
    }
    return `thread:${neutralizeAgentRaftRefLiterals(result.parentChannelName ?? "unknown")}:${shortId}`;
  }
  if (result.channelType === "dm") {
    return `dm:${neutralizeAgentRaftRefLiterals(result.channelName ?? "unknown")}`;
  }
  return `channel:${neutralizeAgentRaftRefLiterals(result.channelName ?? "unknown")}`;
}

const PREVIEW_BEFORE_CHARS = 80;
const PREVIEW_AFTER_CHARS = 120;
const PREVIEW_FALLBACK_CHARS = PREVIEW_BEFORE_CHARS + PREVIEW_AFTER_CHARS;

interface SearchMatchRange {
  start: number;
  end: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findSearchMatch(content: string, query: string): SearchMatchRange | null {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return null;

  const exactIndex = content.toLowerCase().indexOf(normalizedQuery.toLowerCase());
  if (exactIndex >= 0) {
    return { start: exactIndex, end: exactIndex + normalizedQuery.length };
  }

  const terms = normalizedQuery.match(/"([^"]+)"|\S+/g) ?? [];
  for (const rawTerm of terms) {
    const term = rawTerm.replace(/^"|"$/g, "").trim();
    if (!term) continue;
    const match = new RegExp(escapeRegExp(term), "i").exec(content);
    if (match?.index !== undefined) {
      return { start: match.index, end: match.index + match[0].length };
    }
  }

  return null;
}

function* findRaftRefLiteralRanges(content: string): Generator<SearchMatchRange> {
  for (const match of content.matchAll(/\bdm:@[A-Za-z0-9][A-Za-z0-9_-]*(?:~(?:agent|human))?/g)) {
    if (match.index !== undefined) yield { start: match.index, end: match.index + match[0].length };
  }
  for (const match of content.matchAll(/\btask #[0-9]+\b/g)) {
    if (match.index !== undefined) yield { start: match.index, end: match.index + match[0].length };
  }
  for (const match of content.matchAll(/(^|[\n\s([{"'`;])(@[A-Za-z0-9][A-Za-z0-9_-]*)/g)) {
    if (match.index === undefined) continue;
    const prefix = match[1] ?? "";
    const ref = match[2] ?? "";
    yield { start: match.index + prefix.length, end: match.index + prefix.length + ref.length };
  }
  for (const match of content.matchAll(/(^|[\n\s([{"'`;])(#[A-Za-z][A-Za-z0-9_-]*)/g)) {
    if (match.index === undefined) continue;
    const prefix = match[1] ?? "";
    const ref = match[2] ?? "";
    yield { start: match.index + prefix.length, end: match.index + prefix.length + ref.length };
  }
}

function expandSearchMatchToRefLiteral(content: string, match: SearchMatchRange): SearchMatchRange {
  for (const refRange of findRaftRefLiteralRanges(content)) {
    if (match.start < refRange.end && match.end > refRange.start) {
      return {
        start: Math.min(match.start, refRange.start),
        end: Math.max(match.end, refRange.end),
      };
    }
  }
  return match;
}

function trimPreviewWindow(content: string, start: number, end: number): { start: number; end: number } {
  let trimmedStart = start;
  let trimmedEnd = end;
  while (trimmedStart > 0 && /\s/.test(content[trimmedStart] ?? "")) trimmedStart += 1;
  while (trimmedEnd < content.length && /\s/.test(content[trimmedEnd - 1] ?? "")) trimmedEnd -= 1;
  return {
    start: Math.max(0, Math.min(trimmedStart, content.length)),
    end: Math.max(0, Math.min(trimmedEnd, content.length)),
  };
}

function escapeSearchComponentLiterals(text: string): string {
  return text.replace(/<\/?(?:result|preview|match)\b[^>]*>|<omit\s*\/>/gi, (tag) => tag
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;"));
}

/** Neutralise `@handle`, `#channel`, `dm:@peer`, and `task #N` literals so quoted text cannot route attention. */
export function neutralizeAgentRaftRefLiterals(text: string): string {
  return text
    .replace(/\bdm:@([A-Za-z0-9][A-Za-z0-9_-]*(?:~(?:agent|human))?)/g, "dm:user:$1")
    .replace(/\btask #([0-9]+)\b/g, "task:$1")
    .replace(/(^|[\n\s([{"'`;])@([A-Za-z0-9][A-Za-z0-9_-]*)/g, "$1user:$2")
    .replace(/(^|[\n\s([{"'`;])#([A-Za-z][A-Za-z0-9_-]*)/g, "$1channel:$2");
}

export function renderAgentSearchPreviewText(text: string): string {
  return neutralizeAgentRaftRefLiterals(escapeSearchComponentLiterals(text));
}

function renderSearchPreview(content: string, query: string): string {
  const foundMatch = findSearchMatch(content, query);
  const match = foundMatch ? expandSearchMatchToRefLiteral(content, foundMatch) : null;

  let start = 0;
  let end = Math.min(content.length, PREVIEW_FALLBACK_CHARS);
  if (match) {
    start = Math.max(0, match.start - PREVIEW_BEFORE_CHARS);
    end = Math.min(content.length, match.end + PREVIEW_AFTER_CHARS);
  }
  ({ start, end } = trimPreviewWindow(content, start, end));

  const leadingOmit = start > 0 ? "<omit />" : "";
  const trailingOmit = end < content.length ? "<omit />" : "";

  if (!match || match.end <= start || match.start >= end) {
    return `${leadingOmit}${renderAgentSearchPreviewText(content.slice(start, end))}${trailingOmit}`;
  }

  const before = content.slice(start, match.start);
  const matched = content.slice(match.start, match.end);
  const after = content.slice(match.end, end);
  return [
    leadingOmit,
    renderAgentSearchPreviewText(before),
    "<match>",
    renderAgentSearchPreviewText(matched),
    "</match>",
    renderAgentSearchPreviewText(after),
    trailingOmit,
  ].join("");
}

/** Search results with <match>/<omit /> preview markup. */
export function formatAgentSearchResults(query: string, data: AgentSearchData, offset?: number, sort?: string, limit?: number, style: RaftHintStyle = "cli"): string {
  const trimmedQuery = query.trim();
  // Flags named in this prose are the operation's argument names in the tool form.
  const flag = (name: string) => formatHintFlag(name, name, style);
  const oldestShown = data.results?.length ? data.results[data.results.length - 1]?.createdAt : undefined;
  const nextPageHint = sort === "recent" && oldestShown
    ? `page with ${flag("before")} ${oldestShown} (pages OLDER only; NOT a complete traversal: stored times `
      + `are microsecond but this key is millisecond, so rows inside the boundary millisecond can be `
      + `skipped, and a full page sharing one timestamp can repeat indefinitely; copy the key verbatim)`
    : `page with ${flag("offset")} ${(offset ?? 0) + (data.results?.length ?? 0)}`;
  const effectiveLimit = Math.min(limit ?? AGENT_API_MESSAGE_SEARCH_DEFAULT_LIMIT, AGENT_API_MESSAGE_SEARCH_MAX_LIMIT);
  const countEqualsLimit = (data.results?.length ?? 0) === effectiveLimit;
  const limitSource = limit === undefined
    ? `the server default of ${effectiveLimit}`
    : limit > AGENT_API_MESSAGE_SEARCH_MAX_LIMIT
      ? `the server cap of ${effectiveLimit} (your ${flag("limit")} ${limit} was clamped)`
      : `the ${flag("limit")} ${effectiveLimit} that was requested`;
  const atCapRemedy = effectiveLimit < AGENT_API_MESSAGE_SEARCH_MAX_LIMIT
    ? `re-run with a higher ${flag("limit")} to tell the two apart`
    : `this is already the server's maximum page, so completeness CANNOT be determined from this `
      + `result: a higher ${flag("limit")} is clamped back to ${effectiveLimit} and paging will not reveal it; `
      + `narrow the query (add ${flag("sender")}, ${flag("target")}, ${flag("after")} or ${flag("before")}) until fewer than `
      + `${effectiveLimit} results match`;
  const truncation = data.hasMore === true
    ? `truncated=true · more results exist, ${nextPageHint}`
    : data.hasMore === false
      ? countEqualsLimit
        ? `truncated=unknown · server reported hasMore=false, but this page returned exactly `
          + `${limitSource}, which is also what a capped page returns; ${atCapRemedy}`
        : "truncated=false"
      : "truncated=unknown · server did not report hasMore";
  if (!data.results || data.results.length === 0) return (`No search results. (${truncation})`);

  const formatted = data.results.map((result) => {
    const ref = `msg:${result.id}`;
    const content = result.content ?? result.snippet ?? "";
    const sender = neutralizeAgentRaftRefLiterals(result.senderName ?? "unknown");
    const senderType = result.senderType ? ` (${result.senderType})` : "";
    const taskProjection = formatAgentTaskCurrentProjection(result.taskCurrentProjection, result.taskNumber, renderAgentSearchPreviewText).trimStart();
    return [
      `<result ref="${ref}">`,
      `Source: ${renderSearchSource(result)}`,
      `Sender: ${sender}${senderType}`,
      `Time: ${result.createdAt ? formatLocalTimeWithOffset(result.createdAt) : "-"}`,
      ...(taskProjection ? [taskProjection] : []),
      "",
      "<preview>",
      renderSearchPreview(content, trimmedQuery),
      "</preview>",
      "</result>",
    ].join("\n");
  }).join("\n\n");

  const resultLabel = data.results.length === 1 ? "result" : "results";
  const count = `${data.results.length} ${resultLabel} · ${truncation}`;
  return ([
    trimmedQuery
      ? `Search results for: "${trimmedQuery}" (${count})`
      : `Filtered message results (${count})`,
    "",
    formatted,
    "",
    "If a result may be relevant but its preview is not enough, read the surrounding context for that result before answering.",
  ].join("\n"));
}
