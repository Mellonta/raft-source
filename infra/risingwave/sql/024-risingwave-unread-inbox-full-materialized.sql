-- RisingWave full materialization draft for sidebar unread summary and Inbox.
--
-- This file is intentionally documentation / deployment input only. It is not
-- run by the Postgres migration runner. Create these objects in RisingWave only
-- after review and a production deployment plan.
--
-- The authoritative Postgres serving behavior remains the legacy inline SQL in
-- packages/server/src/services/channelService.ts. The already-applied
-- pg_* views in packages/server/drizzle/0084_risingwave_pg_views.sql are
-- kept as reference contracts only; production no-env traffic does not query
-- those views. Keep this RW DDL, the inline PG SQL, and the pg_* reference
-- views aligned when changing inbox/unread semantics.
--
-- Server code uses these objects only when RISINGWAVE_DATABASE_URL is set.
-- Without that env var, the server uses the legacy inline Postgres SQL path.
-- The inbox MV is intentionally a wide serving contract rather than a narrow
-- activity MV: benchmark probes showed the narrow MV made light users pay
-- multi-join serving overhead, while the indexed wide MV keeps both light and
-- heavy cases fast.
--
-- Contract version: RISINGWAVE_UNREAD_INBOX_CONTRACT_VERSION = 2.
-- Serving rollout: server reads the code-selected serving version; do not add
-- a runtime env switch for v1/v2. This contract depends on matching RW objects
-- and must move through a reviewed code + DDL rollout.
--
-- If the Postgres inbox/unread-summary SQL semantics change, update the inline
-- PG SQL, the pg_* reference views, and this file in the same PR and rerun
-- packages/server/scripts/verify-risingwave-inbox-parity.ts against a sampled
-- PG/RW environment before switching the serving version in code.
--
-- Required CDC tables:
--   rw_channels, rw_messages, rw_channel_humans, rw_user_channel_read_cursors,
--   rw_user_channel_inbox_states, rw_thread_follows, rw_tasks,
--   rw_message_mentions, rw_server_members, rw_joint_channels,
--   rw_joint_channel_servers.
--
-- Prereq: RisingWave CDC must include the Postgres message_mentions table as
-- rw_message_mentions before applying this file. The CDC source/table DDL is
-- managed outside this repo; see:
-- https://docs.risingwave.com/ingestion/sources/postgres-cdc
--
-- Current exclusions:
--   - Per-plan history_cutoff requests stay on Postgres; these global MVs cover
--     the full retained history.
--   - User/agent display names are intentionally not materialized here. The
--     server resolves those page-bounded from Postgres to avoid adding sensitive
--     profile tables to the CDC surface.
--
-- Production preflight for rw_followed_thread_stats_v1:
--   1. The server reads this MV unconditionally (RisingWave is a hard
--      dependency; there is no rollback flag or Postgres fallback), so do not
--      deploy a server against a RisingWave until this MV, its lookup index,
--      and sampled row-completeness checks pass.
--   2. Snapshot actor/capacity state before DDL. RisingWave exposes
--      rw_catalog.rw_actors, rw_catalog.rw_streaming_jobs, and
--      rw_catalog.rw_worker_nodes for this; at minimum capture:
--        SELECT count(*) AS actor_count FROM rw_catalog.rw_actors;
--        SELECT * FROM rw_catalog.rw_streaming_jobs ORDER BY name;
--        SELECT * FROM rw_catalog.rw_worker_nodes ORDER BY id;
--      Prod has previously rejected ad hoc MV creation with actor-count
--      protection. If this MV creation is rejected, stop and get capacity
--      approval instead of bypassing or retrying with higher parallelism.
--   3. Use BACKGROUND_DDL and monitor:
--        SELECT ddl_id, ddl_statement, progress
--        FROM rw_catalog.rw_ddl_progress
--        WHERE ddl_statement ILIKE '%rw_followed_thread_stats_v1%';
--        SELECT *
--        FROM rw_catalog.rw_fragment_backfill_progress
--        WHERE job_name ILIKE '%rw_followed_thread_stats_v1%';
--   4. After backfill and index creation, validate row completeness for sampled
--      heavy followers before enabling serving:
--        WITH expected AS (
--          SELECT t.server_id, tf.follower_id AS user_id, t.id AS thread_channel_id
--          FROM rw_thread_follows AS tf
--          JOIN rw_channels AS t
--            ON t.id = tf.thread_channel_id
--           AND t.type = 'thread'
--           AND t.deleted_at IS NULL
--          WHERE tf.follower_type = 'user'
--            AND tf.done_at IS NULL
--            AND tf.unfollowed_at IS NULL
--            AND t.server_id = '<server-id>'
--            AND tf.follower_id = '<user-id>'
--        )
--        SELECT
--          count(*) AS expected_count,
--          count(s.thread_channel_id) AS stats_count,
--          count(*) FILTER (WHERE s.thread_channel_id IS NULL) AS missing_count
--        FROM expected AS e
--        LEFT JOIN rw_followed_thread_stats_v1 AS s
--          ON s.server_id = e.server_id
--         AND s.user_id = e.user_id
--         AND s.thread_channel_id = e.thread_channel_id;
--      missing_count must be 0 before flipping the feature flag. Server code
--      also fails closed to Postgres with fallback_reason=rw_row_mismatch if a
--      later lookup ever returns partial rows.

SET BACKGROUND_DDL = true;
SET streaming_parallelism = 4;

-- Contract: rw_channel_latest_message_v1
-- Mirror reference: pg_channel_latest_message_v1 in migration
-- 0084_risingwave_pg_views.sql. Keep column names, types, and semantics
-- aligned with the PG reference view.
CREATE MATERIALIZED VIEW rw_channel_latest_message_v1 AS
SELECT
  channel_id,
  id AS message_id,
  seq AS latest_seq,
  content,
  sender_type,
  sender_id,
  created_at
FROM (
  SELECT
    m.channel_id,
    m.id,
    m.seq,
    m.content,
    m.sender_type,
    m.sender_id,
    m.created_at,
    row_number() OVER (PARTITION BY m.channel_id ORDER BY m.seq DESC, m.id DESC) AS rn
  FROM rw_messages AS m
) ranked
WHERE rn = 1;

-- Contract: rw_user_channel_unread_v1
-- Mirror reference: pg_user_channel_unread_v1 in migration
-- 0084_risingwave_pg_views.sql. Keep column names, types, and semantics
-- aligned with the PG reference view.
CREATE MATERIALIZED VIEW rw_user_channel_unread_v1 AS
SELECT
  ch.user_id,
  c.server_id,
  c.id AS channel_id,
  COALESCE(rc.last_read_seq, 0) AS last_read_seq,
  count(m.id)::int AS unread_count,
  min(m.seq) AS first_unread_seq
FROM rw_channel_humans AS ch
JOIN rw_channels AS c
  ON c.id = ch.channel_id
LEFT JOIN rw_user_channel_read_cursors AS rc
  ON rc.channel_id = c.id
 AND rc.user_id = ch.user_id
LEFT JOIN rw_messages AS m
  ON m.channel_id = c.id
 AND m.seq > COALESCE(rc.last_read_seq, 0)
 AND NOT (m.sender_type = 'user' AND m.sender_id = ch.user_id)
WHERE c.deleted_at IS NULL
  AND c.archived_at IS NULL
  AND c.type IN ('channel', 'private', 'dm')
GROUP BY ch.user_id, c.server_id, c.id, COALESCE(rc.last_read_seq, 0);

-- Contract: rw_sidebar_unread_summary_v1
-- This materialized view must maintain the same column names, types, and
-- semantics as the PG reference view pg_sidebar_unread_summary_v1 in migration
-- 0084_risingwave_pg_views.sql. If you change this MV, you MUST also update
-- the PG inline SQL/reference view and rerun:
--   pnpm --filter @botiverse/raft-server risingwave:verify-inbox-parity
CREATE MATERIALIZED VIEW rw_sidebar_unread_summary_v1 AS
SELECT
  user_id,
  server_id,
  sum(unread_count)::int AS unread_count
FROM rw_user_channel_unread_v1
WHERE unread_count > 0
GROUP BY user_id, server_id;

-- Contract: rw_followed_thread_stats_v1
-- Endpoint-shaped serving read model for GET /api/channels/threads/followed.
-- This intentionally materializes the full stats row keyed by
-- (server_id, user_id, thread_channel_id) rather than computing it request-time
-- from Postgres. Before creating this MV in production, check RW actor budget
-- because production has previously hit actor-count protection on ad hoc MV
-- creation.
CREATE MATERIALIZED VIEW rw_followed_thread_stats_v1 AS
WITH followed_threads AS (
  SELECT
    t.server_id,
    tf.follower_id AS user_id,
    t.id AS thread_channel_id,
    COALESCE(canonical_thread.id, t.id) AS storage_thread_channel_id
  FROM rw_thread_follows AS tf
  JOIN rw_channels AS t
    ON t.id = tf.thread_channel_id
   AND t.type = 'thread'
   AND t.deleted_at IS NULL
  LEFT JOIN rw_joint_channel_servers AS thread_projection
    ON thread_projection.local_channel_id = t.id
   AND thread_projection.server_id = t.server_id
   AND thread_projection.status = 'active'
  LEFT JOIN rw_joint_channels AS thread_joint
    ON thread_joint.id = thread_projection.joint_channel_id
   AND thread_joint.status = 'active'
  LEFT JOIN rw_channels AS canonical_thread
    ON canonical_thread.id = thread_joint.canonical_channel_id
   AND canonical_thread.type = 'thread'
   AND canonical_thread.deleted_at IS NULL
  WHERE tf.follower_type = 'user'
    AND tf.done_at IS NULL
    AND tf.unfollowed_at IS NULL
),
stats AS (
  SELECT
    ft.server_id,
    ft.user_id,
    ft.thread_channel_id,
    ft.storage_thread_channel_id,
    COALESCE(rc.last_read_seq, 0) AS last_read_seq,
    count(m.id)::int AS reply_count,
    count(m.id) FILTER (
      WHERE m.seq > COALESCE(rc.last_read_seq, 0)
        AND NOT (m.sender_type = 'user' AND m.sender_id = ft.user_id)
    )::int AS unread_count,
    max(m.seq) AS latest_seq,
    min(m.seq) FILTER (
      WHERE m.seq > COALESCE(rc.last_read_seq, 0)
        AND NOT (m.sender_type = 'user' AND m.sender_id = ft.user_id)
    ) AS first_unread_seq
  FROM followed_threads AS ft
  LEFT JOIN rw_user_channel_read_cursors AS rc
    ON rc.channel_id = ft.thread_channel_id
   AND rc.user_id = ft.user_id
  LEFT JOIN rw_messages AS m
    ON m.channel_id = ft.storage_thread_channel_id
  GROUP BY
    ft.server_id,
    ft.user_id,
    ft.thread_channel_id,
    ft.storage_thread_channel_id,
    COALESCE(rc.last_read_seq, 0)
)
SELECT
  stats.server_id,
  stats.user_id,
  stats.thread_channel_id,
  stats.storage_thread_channel_id,
  stats.last_read_seq,
  stats.reply_count,
  stats.unread_count,
  stats.latest_seq,
  stats.first_unread_seq,
  latest.id AS latest_message_id,
  latest.created_at AS last_reply_at,
  latest.content AS latest_preview,
  latest.sender_type AS latest_sender_type,
  latest.sender_id AS latest_sender_id,
  first_unread.id AS first_unread_message_id
FROM stats
LEFT JOIN rw_messages AS latest
  ON latest.channel_id = stats.storage_thread_channel_id
 AND latest.seq = stats.latest_seq
LEFT JOIN rw_messages AS first_unread
  ON first_unread.channel_id = stats.storage_thread_channel_id
 AND first_unread.seq = stats.first_unread_seq;

-- Contract: rw_channel_unread_counts_v2
-- This is the dedicated user-scoped serving MV for GET /api/channels/unread
-- private/DM/joint/thread rows. Public non-thread channel unread is computed in
-- the serving query because public channels are visible to any current user, but
-- read cursor and self-sent-message exclusion still depend on the requested
-- userId; RW intentionally does not CDC the Slock users/profile table. SYNC
-- REQUIRED: if the inline Postgres SQL in getUnreadCounts changes membership,
-- thread parent access, archived/deleted, history-cutoff, or count semantics,
-- update this MV, the dynamic public-channel RW serving query, and rerun:
--   pnpm --filter @botiverse/raft-server risingwave:verify-inbox-parity
-- The v2 MV covers full retained history. Per-plan history_cutoff requests stay
-- on Postgres until a cutoff-aware RW contract is designed.
CREATE MATERIALIZED VIEW rw_channel_unread_counts_v2 AS
WITH non_thread_eligible_channels AS (
  SELECT
    ch.user_id,
    c.server_id,
    c.id AS source_channel_id,
    COALESCE(joint_storage.canonical_channel_id, c.id) AS storage_channel_id
  FROM rw_channel_humans AS ch
  JOIN rw_channels AS c
    ON c.id = ch.channel_id
  LEFT JOIN rw_joint_channel_servers AS joint_projection
    ON joint_projection.local_channel_id = c.id
   AND joint_projection.server_id = c.server_id
   AND joint_projection.status = 'active'
  LEFT JOIN rw_joint_channels AS joint_storage
    ON joint_storage.id = joint_projection.joint_channel_id
   AND joint_storage.status = 'active'
  WHERE c.deleted_at IS NULL
    AND c.archived_at IS NULL
    AND c.type IN ('dm', 'private', 'joint')
),
non_thread_unread AS (
  SELECT
    e.user_id,
    e.server_id,
    e.source_channel_id AS channel_id,
    count(m.id)::int AS unread_count
  FROM non_thread_eligible_channels AS e
  LEFT JOIN rw_user_channel_read_cursors AS rc
    ON rc.channel_id = e.source_channel_id
   AND rc.user_id = e.user_id
  JOIN rw_messages AS m
    ON m.channel_id = e.storage_channel_id
   AND m.seq > COALESCE(rc.last_read_seq, 0)
   AND NOT (m.sender_type = 'user' AND m.sender_id = e.user_id)
  GROUP BY e.user_id, e.server_id, e.source_channel_id
),
regular_thread_unread AS (
  SELECT
    tf.follower_id AS user_id,
    t.server_id,
    t.id AS channel_id,
    count(m.id)::int AS unread_count
  FROM rw_thread_follows AS tf
  JOIN rw_channels AS t
    ON t.id = tf.thread_channel_id
  JOIN rw_messages AS pm
    ON pm.id = t.parent_message_id
  JOIN rw_channels AS pc
    ON pc.id = pm.channel_id
  LEFT JOIN rw_channel_humans AS pch
    ON pch.channel_id = pc.id
   AND pch.user_id = tf.follower_id
  LEFT JOIN rw_user_channel_read_cursors AS rc
    ON rc.channel_id = t.id
   AND rc.user_id = tf.follower_id
  JOIN rw_messages AS m
    ON m.channel_id = t.id
   AND m.seq > COALESCE(rc.last_read_seq, 0)
   AND NOT (m.sender_type = 'user' AND m.sender_id = tf.follower_id)
  WHERE tf.follower_type = 'user'
    AND tf.done_at IS NULL
    AND tf.unfollowed_at IS NULL
    AND t.type = 'thread'
    AND t.deleted_at IS NULL
    AND pc.deleted_at IS NULL
    AND pc.archived_at IS NULL
    AND (
      pc.type NOT IN ('dm', 'private', 'joint')
      OR pch.user_id IS NOT NULL
    )
  GROUP BY tf.follower_id, t.server_id, t.id
),
joint_thread_unread AS (
  SELECT
    tf.follower_id AS user_id,
    local_thread.server_id,
    local_thread.id AS channel_id,
    count(m.id)::int AS unread_count
  FROM rw_thread_follows AS tf
  JOIN rw_channels AS local_thread
    ON local_thread.id = tf.thread_channel_id
   AND local_thread.type = 'thread'
   AND local_thread.deleted_at IS NULL
  JOIN rw_joint_channel_servers AS thread_projection
    ON thread_projection.local_channel_id = local_thread.id
   AND thread_projection.server_id = local_thread.server_id
   AND thread_projection.status = 'active'
  JOIN rw_joint_channels AS thread_joint
    ON thread_joint.id = thread_projection.joint_channel_id
   AND thread_joint.status = 'active'
  JOIN rw_channels AS canonical_thread
    ON canonical_thread.id = thread_joint.canonical_channel_id
   AND canonical_thread.type = 'thread'
   AND canonical_thread.deleted_at IS NULL
  JOIN rw_messages AS parent_msg
    ON parent_msg.id = canonical_thread.parent_message_id
  JOIN rw_joint_channels AS parent_joint
    ON parent_joint.canonical_channel_id = parent_msg.channel_id
   AND parent_joint.status = 'active'
  JOIN rw_joint_channel_servers AS parent_projection
    ON parent_projection.joint_channel_id = parent_joint.id
   AND parent_projection.server_id = local_thread.server_id
   AND parent_projection.status = 'active'
  JOIN rw_channels AS local_parent
    ON local_parent.id = parent_projection.local_channel_id
   AND local_parent.type = 'joint'
   AND local_parent.archived_at IS NULL
   AND local_parent.deleted_at IS NULL
  JOIN rw_channel_humans AS parent_member
    ON parent_member.channel_id = local_parent.id
   AND parent_member.user_id = tf.follower_id
  LEFT JOIN rw_user_channel_read_cursors AS rc
    ON rc.channel_id = local_thread.id
   AND rc.user_id = tf.follower_id
  JOIN rw_messages AS m
    ON m.channel_id = canonical_thread.id
   AND m.seq > COALESCE(rc.last_read_seq, 0)
   AND NOT (m.sender_type = 'user' AND m.sender_id = tf.follower_id)
  WHERE tf.follower_type = 'user'
    AND tf.done_at IS NULL
    AND tf.unfollowed_at IS NULL
  GROUP BY tf.follower_id, local_thread.server_id, local_thread.id
)
SELECT
  user_id,
  server_id,
  channel_id,
  unread_count
FROM non_thread_unread
UNION ALL
SELECT
  user_id,
  server_id,
  channel_id,
  unread_count
FROM regular_thread_unread
UNION ALL
SELECT
  user_id,
  server_id,
  channel_id,
  unread_count
FROM joint_thread_unread;

CREATE INDEX idx_rw_messages_channel_seq
  ON rw_messages (channel_id, seq);

CREATE INDEX idx_rw_message_mentions_inbox
  ON rw_message_mentions (target_type, target_id, channel_id, message_seq);

CREATE INDEX idx_rw_message_mentions_v2_inbox
  ON rw_message_mentions_v2 (target_type, target_id, channel_id, message_seq);

CREATE INDEX idx_rw_channel_latest_message_channel
  ON rw_channel_latest_message_v1 (channel_id);

CREATE INDEX idx_rw_user_channel_unread_lookup
  ON rw_user_channel_unread_v1 (user_id, channel_id);

CREATE INDEX idx_rw_followed_thread_stats_lookup
  ON rw_followed_thread_stats_v1 (server_id, user_id, thread_channel_id);

CREATE INDEX idx_rw_channel_unread_counts_v2_lookup
  ON rw_channel_unread_counts_v2 (server_id, user_id, channel_id);

CREATE INDEX idx_rw_sidebar_unread_summary_lookup
  ON rw_sidebar_unread_summary_v1 (user_id, server_id);

-- The wide inbox serving MV must be indexed before it is used for serving.
-- Without these indexes, light-user queries can spend most of their time
-- scanning the materialized rows even though the joins have already been paid.