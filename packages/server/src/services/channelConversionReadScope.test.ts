import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { dbTest } from "../test/integration/dbTest";
import { messages } from "../db/schema";
import {
  conversionReadChannelIdsQuery,
  conversionReadChannelPredicate,
  resolveConversionReadChannelIds,
  resolvedConversionReadChannelPredicate,
} from "./channelConversionReadScope";
import { getMessageContext, listMessages, listMessagesWithCoverage } from "./messageService";

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function renderedQuerySql(query: unknown): string | null {
  if (!query || typeof query !== "object" || !("toSQL" in query) || typeof query.toSQL !== "function") {
    return null;
  }
  return normalizeSql(String(query.toSQL().sql));
}

test("dynamic conversion read scope remains statement-local", () => {
  const rendered = normalizeSql(new PgDialect().sqlToQuery(sql`
    SELECT *
    FROM ${messages}
    WHERE ${conversionReadChannelPredicate(messages.channelId, "11111111-1111-4111-8111-111111111111")}
    ORDER BY ${messages.seq} DESC
    LIMIT 1
  `).sql);

  assert.match(rendered, /"messages"\."channel_id" IN \( SELECT \$1::uuid AS id UNION/);
  assert.match(rendered, /ORDER BY "messages"\."seq" DESC LIMIT 1/);
});

test("conversion scope resolver consumes the named id column", async () => {
  let rendered = "";
  const executor = {
    execute: async (query: ReturnType<typeof conversionReadChannelIdsQuery>) => {
      rendered = normalizeSql(new PgDialect().sqlToQuery(query).sql);
      return { rows: [{ id: "11111111-1111-4111-8111-111111111111" }] };
    },
  };

  const ids = await resolveConversionReadChannelIds(
    executor as Parameters<typeof resolveConversionReadChannelIds>[0],
    "11111111-1111-4111-8111-111111111111",
  );

  assert.deepEqual(ids, ["11111111-1111-4111-8111-111111111111"]);
  assert.match(rendered, /^SELECT \$1::uuid AS id UNION/);
});

dbTest("message history consumes resolved ids as an indexable predicate", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const message = await seed.message({ channel, author: owner, content: "quiet channel message" });
  let loadedPageSql = "";

  const rows = await listMessages(channel.id, 1, undefined, undefined, undefined, {
    traceQuery: async (queryName, work) => {
      const query = work();
      const rendered = renderedQuerySql(query);
      if (queryName === "messages.channel.loaded_page" && rendered) loadedPageSql = rendered;
      return query;
    },
  });

  assert.deepEqual(rows.map((row) => row.id), [message.id]);
  assert.match(loadedPageSql, /where "messages"\."channel_id" = \$1 order by "messages"\."seq" desc limit \$2/);
  assert.doesNotMatch(loadedPageSql, /channel_id" IN \( SELECT/);

  const coverageSql: string[] = [];
  const page = await listMessagesWithCoverage(channel.id, 1, undefined, undefined, undefined, {
    traceQuery: async (queryName, work) => {
      const query = work();
      const rendered = renderedQuerySql(query);
      if (
        rendered
        && (queryName === "messages.channel.loaded_page" || queryName === "messages.channel.coverage_bound")
      ) {
        coverageSql.push(rendered);
      }
      return query;
    },
  });

  assert.deepEqual(page.messages.map((row) => row.id), [message.id]);
  assert.equal(coverageSql.length, 2);
  for (const rendered of coverageSql) {
    assert.match(rendered, /where "messages"\."channel_id" = \$\d+/);
    assert.doesNotMatch(rendered, /channel_id" IN \( SELECT/);
  }
});

test("resolved single-channel history scope compiles to an equality index condition", () => {
  const rendered = normalizeSql(new PgDialect().sqlToQuery(sql`
    SELECT *
    FROM ${messages}
    WHERE ${resolvedConversionReadChannelPredicate(messages.channelId, ["11111111-1111-4111-8111-111111111111"])}
    ORDER BY ${messages.seq} DESC
    LIMIT 1
  `).sql);

  assert.match(rendered, /WHERE "messages"\."channel_id" = \$1 ORDER BY "messages"\."seq" DESC LIMIT 1/);
  assert.doesNotMatch(rendered, /channel_id" IN \( SELECT/);
});

dbTest("message context previous/next consume resolved ids as an indexable predicate", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const older = await seed.message({ channel, author: owner, content: "older" });
  const target = await seed.message({ channel, author: owner, content: "target" });
  const newer = await seed.message({ channel, author: owner, content: "newer" });
  let previousSql = "";
  let nextSql = "";

  const aroundLimit1 = await getMessageContext(target.id, 0, 0, undefined, {
    traceQuery: async (queryName, work) => {
      const query = work();
      const rendered = renderedQuerySql(query);
      if (queryName === "messages.context.previous" && rendered) previousSql = rendered;
      if (queryName === "messages.context.next" && rendered) nextSql = rendered;
      return query;
    },
  });

  assert.equal(aroundLimit1?.targetMessageId, target.id);
  assert.deepEqual(aroundLimit1?.messages.map((row) => row.id), [target.id]);
  assert.match(
    previousSql,
    /where \("messages"\."channel_id" = \$1 and "messages"\."seq" < \$2\) order by "messages"\."seq" desc limit \$3/,
  );
  assert.doesNotMatch(previousSql, /channel_id" IN \( SELECT/);
  assert.match(
    nextSql,
    /where \("messages"\."channel_id" = \$1 and "messages"\."seq" > \$2\) order by "messages"\."seq" limit \$3/,
  );
  assert.doesNotMatch(nextSql, /channel_id" IN \( SELECT/);

  const aroundWindow = await getMessageContext(target.id, 1, 1);
  assert.deepEqual(aroundWindow?.messages.map((row) => row.id), [older.id, target.id, newer.id]);
});
