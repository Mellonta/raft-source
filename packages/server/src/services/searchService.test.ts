import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  buildAgentVisibleChannelsRowCheckSql,
  buildAgentVisibleChannelsSql,
  buildUserVisibleChannelsSql,
  buildMessageSearchBreadthProbeSql,
  buildMessageSearchTextMatchProbeSql,
  buildSearchCandidateCtes,
  buildSearchText,
  classifyMessageSearchBreadth,
  classifyMessageSearchTextMatchBreadth,
  MESSAGE_SEARCH_BREADTH_PROBE_TIMEOUT_MS,
  MESSAGE_SEARCH_COMMON_TERM_CORPUS_FRACTION,
  MESSAGE_SEARCH_RELEVANCE_ESTIMATED_CANDIDATE_LIMIT,
  MESSAGE_SEARCH_RELEVANCE_ESTIMATED_TEXT_MATCH_LIMIT,
  preprocessSearchContent,
  readMessageSearchEstimatedCandidateRows,
  tokenizeSearchText,
} from "./searchService";

function normalizeSql(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

test("preprocessSearchContent preserves markdown link text and inline code while removing URLs", () => {
  const input = "参考 [Neon 文档](https://neon.com/docs) 然后运行 `npm install express`";
  const output = preprocessSearchContent(input);
  assert.match(output, /Neon 文档/);
  assert.match(output, /npm install express/);
  assert.doesNotMatch(output, /https:\/\/neon\.com/);
});

test("tokenizeSearchText keeps English words intact while segmenting Chinese", () => {
  const tokens = tokenizeSearchText("部署到staging环境并执行 npm install express");
  assert.deepEqual(tokens, ["部署", "到", "staging", "环境", "并", "执行", "npm", "install", "express"]);
});

test("buildSearchText removes markdown noise from rich text", () => {
  const searchText = buildSearchText("**部署方案** 已写好，见 `config.ts` 和 https://example.com");
  assert.equal(searchText, "部署 方案 已写 好 见 config ts 和");
});

test("agent search visible-channel query is agent-first without membership left joins", () => {
  const dialect = new PgDialect();
  const rendered = normalizeSql(dialect.sqlToQuery(buildAgentVisibleChannelsSql({
    serverId: "00000000-0000-4000-8000-000000000001",
    agentId: "00000000-0000-4000-8000-000000000002",
  })).sql);

  assert.match(rendered, /\bUNION ALL\b/);
  assert.match(rendered, /\bFROM channel_agents ca JOIN channels member_channels\b/);
  assert.match(rendered, /\bFROM channel_agents pca JOIN channels pc ON pc\.id = pca\.channel_id\b/);
  // Threads come from the parent side via channels.parent_channel_id: no messages reads.
  assert.equal(rendered.match(/\bJOIN channels tc ON tc\.parent_channel_id = pc\.id\b/g)?.length, 2);
  assert.doesNotMatch(rendered, /\bmessages\b/);
  assert.doesNotMatch(rendered, /\bLEFT JOIN channel_agents\b/);
  assert.doesNotMatch(rendered, /\bmember_channels\.type IN \('private', 'dm'\) AND ca\.agent_id IS NOT NULL\b/);
  assert.doesNotMatch(rendered, /\bpc\.type IN \('private', 'dm'\) AND pca\.agent_id IS NOT NULL\b/);
});

test("search visible-channel queries exclude soft-deleted channels and threads whose parent is soft-deleted", () => {
  const dialect = new PgDialect();
  const serverId = "00000000-0000-4000-8000-000000000001";

  const human = normalizeSql(dialect.sqlToQuery(buildUserVisibleChannelsSql({
    serverId,
    userId: "00000000-0000-4000-8000-000000000003",
  })).sql);
  assert.match(human, /\bAND visible_channels\.deleted_at IS NULL\b/);
  assert.match(human, /\bAND parent_channels\.deleted_at IS NULL\b/);

  const humanWithRoots = normalizeSql(dialect.sqlToQuery(buildUserVisibleChannelsSql({
    serverId,
    userId: "00000000-0000-4000-8000-000000000003",
    allowedRootChannelIds: ["00000000-0000-4000-8000-000000000004"],
  })).sql);
  assert.match(humanWithRoots, /\bAND visible_channels\.deleted_at IS NULL\b/);
  assert.match(humanWithRoots, /\bAND parent_channels\.deleted_at IS NULL\b/);

  const agent = normalizeSql(dialect.sqlToQuery(buildAgentVisibleChannelsSql({
    serverId,
    agentId: "00000000-0000-4000-8000-000000000002",
  })).sql);
  assert.match(agent, /\bAND public_channels\.deleted_at IS NULL\b/);
  assert.match(agent, /\bAND member_channels\.deleted_at IS NULL\b/);
  // Both thread arms (public parent, private/dm parent) filter the thread and its parent.
  assert.equal(agent.match(/\bAND tc\.deleted_at IS NULL\b/g)?.length, 2);
  assert.equal(agent.match(/\bAND pc\.deleted_at IS NULL\b/g)?.length, 2);
  assert.doesNotMatch(human, /\bmessages\b/, "user visibility resolves thread parents without reading messages");
});

test("relevance search collects text matches first, then keeps the visible ones before ranking", () => {
  const dialect = new PgDialect();
  const rendered = normalizeSql(dialect.sqlToQuery(buildSearchCandidateCtes({
    tsQuery: sql`plainto_tsquery('simple', ${"hehe"})`,
    sort: "relevance",
    limit: 20,
    offset: 0,
    channelFilter: sql``,
    channelScopeFilter: sql``,
    textMatchChannelScopeFilter: sql``,
    senderFilter: sql``,
    senderTypeFilter: sql``,
    mentionTargetFilter: sql``,
    afterFilter: sql``,
    beforeFilter: sql``,
  })).sql);

  // A fixed shape, so the planner never chooses to run the GIN match once per
  // visible channel: text_matches holds only ids, content and rank read
  // visible rows only.
  assert.match(rendered, /^text_matches AS MATERIALIZED \( SELECT m\.id AS id, m\.channel_id AS channel_id FROM messages m WHERE m\.search_vector @@ \(plainto_tsquery\('simple', \$\d+\)\)/);
  assert.match(rendered, /\bmatched_messages AS MATERIALIZED \(.*\bFROM text_matches tm JOIN visible_channels vc ON vc\.id = tm\.channel_id JOIN messages m ON m\.id = tm\.id WHERE\b/);
  assert.match(rendered, /\bFROM matched_messages mm ORDER BY\b/);
  assert.doesNotMatch(rendered, /\bFROM visible_channels vc JOIN messages m\b/);
  assert.doesNotMatch(rendered, /\bFROM matched_messages mm JOIN visible_channels vc\b/);
});

test("relevance search narrows text matches to the filtered channel and keeps the exact filter after visibility", () => {
  const dialect = new PgDialect();
  const rendered = normalizeSql(dialect.sqlToQuery(buildSearchCandidateCtes({
    tsQuery: sql`plainto_tsquery('simple', ${"hehe"})`,
    sort: "relevance",
    limit: 20,
    offset: 0,
    channelFilter: sql`AND (m.channel_id = ${"channel-1"} OR vc.parent_channel_id = ${"channel-1"})`,
    channelScopeFilter: sql`AND m.channel_id IN (SELECT ${"channel-1"}::uuid)`,
    textMatchChannelScopeFilter: sql`AND m.channel_id = ANY(ARRAY(SELECT ${"channel-1"}::uuid))`,
    senderFilter: sql``,
    senderTypeFilter: sql``,
    mentionTargetFilter: sql``,
    afterFilter: sql``,
    beforeFilter: sql``,
  })).sql);

  assert.match(
    rendered,
    /^text_matches AS MATERIALIZED \(.*\bAND m\.channel_id = ANY\(ARRAY\(SELECT \$\d+::uuid\)\).*\), matched_messages AS MATERIALIZED \(.*\bAND \(m\.channel_id = \$\d+ OR vc\.parent_channel_id = \$\d+\).*\), search_candidates AS \(/,
  );
});

test("channel filter: text matches get the scope as a precomputed array, the walk keeps the hashed IN", async () => {
  const { buildMessageSearchStatement } = await import("./searchService");
  const dialect = new PgDialect();
  const render = (sort: "relevance" | "recent", recentPlan?: "walk" | "text_matches_first") => normalizeSql(dialect.sqlToQuery(buildMessageSearchStatement(
    sql`SELECT NULL::uuid AS id, NULL::uuid AS parent_channel_id`,
    { serverId: "00000000-0000-4000-8000-000000000001", channelId: "00000000-0000-4000-8000-000000000009", sort, recentPlan, limit: 20, offset: 0 },
    sql`plainto_tsquery('simple', ${"flaky"})`,
  )).sql);

  // As IN (subquery) the planner can rescan the GIN index once per scoped
  // thread (3,241 rescans, 4.8s on a 3,240-thread channel); an InitPlan array
  // keeps it to one GIN scan.
  for (const rendered of [render("relevance"), render("recent", "text_matches_first")]) {
    assert.match(rendered, /\bWITH visible_channels AS \(.*\), text_matches AS MATERIALIZED \( SELECT m\.id AS id, m\.channel_id AS channel_id FROM messages m WHERE m\.search_vector @@ \(plainto_tsquery\('simple', \$\d+\)\) AND m\.channel_id = ANY\(ARRAY\( SELECT \$\d+::uuid UNION ALL SELECT scoped_thread\.id FROM channels scoped_thread/);
    assert.doesNotMatch(rendered, /\bm\.channel_id IN \(/);
  }
  // The walk filters every row it passes by the scope: IN is hashed, a parameter array is not (15.5s vs 0.6s).
  const walk = render("recent", "walk");
  assert.match(walk, /\bAND m\.channel_id IN \( SELECT \$\d+::uuid UNION ALL SELECT scoped_thread\.id/);
  assert.doesNotMatch(walk, /\bANY\(ARRAY\(/);
});

test("server timeline walk: the text match cannot become a GIN index condition", async () => {
  const { buildMessageSearchStatement } = await import("./searchService");
  const dialect = new PgDialect();
  const rendered = normalizeSql(dialect.sqlToQuery(buildMessageSearchStatement(
    sql`SELECT NULL::uuid AS id, NULL::uuid AS parent_channel_id`,
    { serverId: "00000000-0000-4000-8000-000000000001", sort: "recent", recentPlan: "server_timeline_walk", limit: 20, offset: 0 },
    sql`plainto_tsquery('simple', ${"means"})`,
  )).sql);

  // A bare @@ lets the planner loop over the visible channels with
  // BitmapAnd(channel index, GIN), rescanning the match set per channel
  // (2,152 rescans, 27s on a 34k-message server) instead of walking.
  assert.match(rendered, /\bFROM message_server_timeline t JOIN messages m ON m\.id = t\.message_id\b.*\bAND \(m\.search_vector @@ \(plainto_tsquery\('simple', \$\d+\)\)\) IS TRUE ORDER BY t\.created_at DESC, t\.message_id DESC\b/);
  assert.doesNotMatch(rendered, /\bAND m\.search_vector @@/);
});

test("filter-only search keeps the page-first visible-channel plan", () => {
  const dialect = new PgDialect();
  const rendered = normalizeSql(dialect.sqlToQuery(buildSearchCandidateCtes({
    tsQuery: null,
    sort: "recent",
    limit: 20,
    offset: 0,
    channelFilter: sql``,
    channelScopeFilter: sql``,
    textMatchChannelScopeFilter: sql``,
    senderFilter: sql`AND m.sender_id = ${"sender-1"}`,
    senderTypeFilter: sql``,
    mentionTargetFilter: sql``,
    afterFilter: sql``,
    beforeFilter: sql``,
  })).sql);

  assert.match(rendered, /^search_candidates AS \(/);
  assert.match(rendered, /\bFROM visible_channels vc JOIN messages m ON m\.channel_id = vc\.id\b/);
  assert.doesNotMatch(rendered, /\bmatched_messages AS MATERIALIZED\b/);
  assert.doesNotMatch(rendered, /\bm\.search_vector @@\b/);
});

test("broad recent search uses the exact page-first visible-channel plan", () => {
  const dialect = new PgDialect();
  const rendered = normalizeSql(dialect.sqlToQuery(buildSearchCandidateCtes({
    tsQuery: sql`plainto_tsquery('simple', ${"the"})`,
    sort: "recent",
    limit: 20,
    offset: 0,
    channelFilter: sql``,
    channelScopeFilter: sql``,
    textMatchChannelScopeFilter: sql``,
    senderFilter: sql``,
    senderTypeFilter: sql``,
    mentionTargetFilter: sql``,
    afterFilter: sql``,
    beforeFilter: sql``,
  })).sql);

  assert.match(rendered, /^search_candidates AS \(/);
  assert.match(rendered, /\bFROM visible_channels vc JOIN messages m ON m\.channel_id = vc\.id\b/);
  assert.match(rendered, /\bm\.search_vector @@ \(plainto_tsquery\('simple', \$\d+\)\)/);
  assert.doesNotMatch(rendered, /\bmatched_messages AS MATERIALIZED\b/);
});

test("recent search on a bounded term takes text matches first and orders by time without ranking", () => {
  const dialect = new PgDialect();
  const rendered = normalizeSql(dialect.sqlToQuery(buildSearchCandidateCtes({
    tsQuery: sql`plainto_tsquery('simple', ${"flaky"})`,
    sort: "recent",
    recentPlan: "text_matches_first",
    limit: 20,
    offset: 0,
    channelFilter: sql``,
    channelScopeFilter: sql``,
    textMatchChannelScopeFilter: sql``,
    senderFilter: sql``,
    senderTypeFilter: sql``,
    mentionTargetFilter: sql``,
    afterFilter: sql``,
    beforeFilter: sql``,
  })).sql);

  assert.match(rendered, /^text_matches AS MATERIALIZED \(/);
  assert.match(rendered, /\bFROM text_matches tm JOIN visible_channels vc ON vc\.id = tm\.channel_id\b/);
  // Same order as the walk (created_at, then id), and no ts_rank_cd over the matches.
  assert.match(rendered, /\b0 AS "searchRank" FROM matched_messages mm ORDER BY mm\.created_at DESC, mm\.id DESC\b/);
  assert.doesNotMatch(rendered, /\bts_rank_cd\b/);
});

test("agent row-check visible set is one join from the channel side", () => {
  const dialect = new PgDialect();
  const rendered = normalizeSql(dialect.sqlToQuery(buildAgentVisibleChannelsRowCheckSql({
    serverId: "00000000-0000-4000-8000-000000000001",
    agentId: "00000000-0000-4000-8000-000000000002",
  })).sql);

  // The recent walk checks visibility per message: a primary-key join the planner can memoize, not a UNION.
  assert.match(rendered, /^SELECT visible_channels\.id AS id, COALESCE\(parent_channels\.id, visible_channels\.id\) AS parent_channel_id FROM channels visible_channels\b/);
  assert.doesNotMatch(rendered, /\bUNION\b/);
  assert.doesNotMatch(rendered, /\bmessages\b/);
  assert.match(rendered, /\bAND visible_channels\.deleted_at IS NULL AND parent_channels\.deleted_at IS NULL\b/);
});

test("breadth probe uses non-executing EXPLAIN over the viewer-scoped filtered FTS query", () => {
  const dialect = new PgDialect();
  const query = dialect.sqlToQuery(buildMessageSearchBreadthProbeSql({
    visibleChannelsSql: sql`SELECT ${"channel-1"}::text AS id, ${"channel-1"}::text AS parent_channel_id`,
    tsQuery: sql`plainto_tsquery('simple', ${"the"})`,
    channelFilter: sql``,
    senderFilter: sql``,
    senderTypeFilter: sql``,
    mentionTargetFilter: sql``,
    afterFilter: sql``,
    beforeFilter: sql``,
  }));
  const rendered = normalizeSql(query.sql);

  assert.match(rendered, /^EXPLAIN \(FORMAT JSON\) WITH visible_channels AS \(/);
  assert.match(rendered, /\bFROM visible_channels vc JOIN messages m ON m\.channel_id = vc\.id\b/);
  assert.match(rendered, /\bm\.search_vector @@ \(plainto_tsquery\('simple', \$\d+\)\)/);
  assert.doesNotMatch(rendered, /\bLIMIT\b|\bANALYZE\b/);
});

test("text-match probe plans the relevance statement's corpus-wide text_matches predicate without executing it", () => {
  const dialect = new PgDialect();
  const rendered = normalizeSql(dialect.sqlToQuery(buildMessageSearchTextMatchProbeSql({
    tsQuery: sql`plainto_tsquery('simple', ${"the"})`,
    channelScopeFilter: sql`AND m.channel_id IN (SELECT ${"channel-1"}::uuid)`,
    senderFilter: sql`AND m.sender_id = ${"sender-1"}`,
    senderTypeFilter: sql``,
    afterFilter: sql``,
    beforeFilter: sql``,
  })).sql);

  assert.match(rendered, /^EXPLAIN \(FORMAT JSON\) SELECT m\.id FROM messages m WHERE m\.search_vector @@ \(plainto_tsquery\('simple', \$\d+\)\) AND m\.channel_id IN \(SELECT \$\d+::uuid\) AND m\.sender_id = \$\d+$/);
  assert.doesNotMatch(rendered, /\bvisible_channels\b|\bLIMIT\b|\bANALYZE\b/);
});

test("text-match classification rejects only estimates above both the fixed limit and the common-term share of the corpus", () => {
  const small = 1_000_000;
  assert.equal(classifyMessageSearchTextMatchBreadth(MESSAGE_SEARCH_RELEVANCE_ESTIMATED_TEXT_MATCH_LIMIT, small), "within_limit");
  assert.equal(classifyMessageSearchTextMatchBreadth(MESSAGE_SEARCH_RELEVANCE_ESTIMATED_TEXT_MATCH_LIMIT + 1, small), "over_limit");
  // A term missing from the statistics is estimated at up to 0.5% of the
  // corpus; on a corpus large enough for that to pass the fixed limit, such a
  // term must stay admitted.
  const large = 100_000_000;
  assert.equal(classifyMessageSearchTextMatchBreadth(large * 0.005, large), "within_limit");
  assert.equal(classifyMessageSearchTextMatchBreadth(large * MESSAGE_SEARCH_COMMON_TERM_CORPUS_FRACTION + 1, large), "over_limit");
  assert.throws(() => classifyMessageSearchTextMatchBreadth(-1, small));
  assert.throws(() => classifyMessageSearchTextMatchBreadth(1, Number.NaN));
});

test("breadth classification accepts the injected threshold and rejects the first estimate above it", () => {
  assert.equal(classifyMessageSearchBreadth(MESSAGE_SEARCH_RELEVANCE_ESTIMATED_CANDIDATE_LIMIT - 1), "within_limit");
  assert.equal(classifyMessageSearchBreadth(MESSAGE_SEARCH_RELEVANCE_ESTIMATED_CANDIDATE_LIMIT), "within_limit");
  assert.equal(classifyMessageSearchBreadth(MESSAGE_SEARCH_RELEVANCE_ESTIMATED_CANDIDATE_LIMIT + 1), "over_limit");
  assert.throws(() => classifyMessageSearchBreadth(-1));
});

test("planner estimate projection is schema-strict and never converts unknown into absence", () => {
  const valid = [{ Plan: { "Node Type": "Nested Loop", "Plan Rows": 42 } }];
  assert.equal(readMessageSearchEstimatedCandidateRows(valid), 42);
  assert.equal(readMessageSearchEstimatedCandidateRows(JSON.stringify(valid)), 42);
  for (const malformed of [null, [], [{ Plan: null }], [{ Plan: { "Plan Rows": null } }], [{ Plan: { "Plan Rows": -1 } }]]) {
    assert.throws(() => readMessageSearchEstimatedCandidateRows(malformed), { name: "MessageSearchUnavailableError" });
  }
});

test("search manual is structurally bound to the code threshold and probe deadline", () => {
  const manual = readFileSync(new URL("../../../../manual/agent-knowledge/search.md", import.meta.url), "utf8");
  assert.match(manual, new RegExp(`at most \\*\\*${MESSAGE_SEARCH_RELEVANCE_ESTIMATED_CANDIDATE_LIMIT.toLocaleString("en-US")} planner-estimated candidate rows\\*\\*`));
  assert.match(manual, new RegExp(`above ${MESSAGE_SEARCH_RELEVANCE_ESTIMATED_CANDIDATE_LIMIT.toLocaleString("en-US")} produces`));
  assert.match(manual, new RegExp(`\\*\\*${MESSAGE_SEARCH_BREADTH_PROBE_TIMEOUT_MS.toLocaleString("en-US")} ms\\*\\*`));
  assert.match(manual, new RegExp(`at most \\*\\*${MESSAGE_SEARCH_RELEVANCE_ESTIMATED_TEXT_MATCH_LIMIT.toLocaleString("en-US")} estimated matching messages across all servers\\*\\*`));
  assert.match(manual, new RegExp(`\\*\\*${MESSAGE_SEARCH_COMMON_TERM_CORPUS_FRACTION * 100}% of all messages\\*\\*`));
});
