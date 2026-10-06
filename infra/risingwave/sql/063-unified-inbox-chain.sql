-- RFC-063 unified inbox chain — one mechanism, two principal kinds.
--
-- STATUS: AS-BUILT. Every deployed cluster carries this chain. Verified by
-- exporting every definition from
-- rw_catalog.rw_materialized_views on each cluster and comparing against this
-- file: 11/11 views and the serving index match on each, with no residual
-- difference beyond RisingWave's own re-emission (varchar -> character varying,
-- explicit AS before aliases). String literals were additionally compared
-- case-sensitively, because a normalizer loose enough to absorb re-emission is
-- also loose enough to hide a real difference.
--
-- BUILD NOTE (the expensive one): rw_inbox_normal_v4 is a fan-out aggregation
-- over every subscription x message pair and cannot be built at full
-- parallelism on a single-node cluster without starving live serving.
-- Uncapped attempts drove barrier latency up by orders of magnitude.
-- SET STREAMING_PARALLELISM = 4 before creating it: that caps the backfill's
-- FOOTPRINT (a fraction of the cores) rather than its rate, which is the axis
-- that matters; barriers then stayed bounded for the whole build with
-- no downtime. backfill_rate_limit does NOT substitute -- it slows each
-- executor while still occupying every core.
--
-- CUTOVER IS NOT DONE. rw_inbox_serving_v4 is receiver-keyed and is NOT
-- shape-compatible with rw_inbox_serving_v3, which deployed code still reads;
-- switching requires the server-side change, not just these definitions.
--
-- Semantics delta vs the 061 chain (all ratified in design review): a
-- principal axis (receiver_type, receiver_id) runs through
-- every layer; unread additionally excludes (a) system messages whose
-- causal actor is the receiver (covers all 10 born-read producers) and
-- (b) two noise system subtypes (the only mode:"skip" producers). The
-- 22-producer born-read registry retires with the old write fan-out; the
-- compile-level duty becomes "producers write causal_actor + system_subtype".
-- Verification: a verdict-complete shadow reconciled fully against recorded
-- facts (the only differences were mention-class and archived-channel cases,
-- by design, and a bounded pre-column legacy case; no backfill by ruling).
--
-- PREREQUISITE (staging-rehearsed first): the messages mirror gains the
-- send-verdict columns in place. NULL is NOT merely a historical artefact that
-- will age out: only a minority of new system messages carry a causal actor
-- (and no chat message does, by design — these columns are
-- system-message-only). NULL is therefore a PERMANENT, ONGOING state and every
-- predicate touching these columns must define its NULL behaviour explicitly.
-- The unread predicates below treat NULL as "no exclusion applies":
--
-- ALTER TABLE rw_messages ADD COLUMN message_type CHARACTER VARYING;      -- already present
-- ALTER TABLE rw_messages ADD COLUMN causal_actor_type CHARACTER VARYING;
-- ALTER TABLE rw_messages ADD COLUMN causal_actor_id CHARACTER VARYING;
-- ALTER TABLE rw_messages ADD COLUMN system_subtype CHARACTER VARYING;

CREATE MATERIALIZED VIEW rw_message_target_v3 AS
WITH proj AS (
  SELECT s.local_channel_id, s.server_id, j.canonical_channel_id
  FROM rw_joint_channel_servers AS s
  JOIN rw_joint_channels AS j ON j.id = s.joint_channel_id
  WHERE s.status = 'active' AND j.status = 'active'
), chan_map AS (
  SELECT c.id AS storage_id, c.id AS target_id
  FROM rw_channels AS c
  LEFT JOIN proj AS p ON p.local_channel_id = c.id
  WHERE c.deleted_at IS NULL AND c.archived_at IS NULL AND p.local_channel_id IS NULL
  UNION ALL
  SELECT p.canonical_channel_id AS storage_id, p.local_channel_id AS target_id FROM proj AS p
)
SELECT map.target_id, m.seq, m.created_at, m.sender_type, m.sender_id,
       m.message_type, m.causal_actor_type, m.causal_actor_id, m.system_subtype
FROM rw_messages AS m
JOIN chan_map AS map ON m.channel_id = map.storage_id;

CREATE MATERIALIZED VIEW rw_target_latest_v4 AS
SELECT target_id, MAX(seq) AS latest_seq, MAX(created_at) AS latest_at, COUNT(*) AS msg_count
FROM rw_message_target_v3
GROUP BY target_id;

-- Inbox eligibility gate. Single upstream definition of "may this target appear in
-- an inbox at all", read by BOTH arms below. Previously this predicate lived at the
-- SERVING layer, i.e. every (subscription x message) pair for a long-dead free-plan
-- target was aggregated and then discarded, which was a large share of all pairs.
-- Gating both arms together reproduces today's behaviour exactly; gating only the
-- unread arm does NOT -- a dead target holding an old unread mention would lose its
-- normal-arm row, fall through to the mention arm and RESURFACE as a mention-only
-- entry (a substantial number of rows). Targets with no messages at all are absent from
-- rw_target_latest_v4 and are kept by the IS NULL arm, which preserves the
-- mention-only-with-no-messages case that serving used to special-case.
CREATE MATERIALIZED VIEW rw_target_eligible_v1 AS
SELECT c.id AS target_id
FROM rw_channels AS c
LEFT JOIN rw_target_latest_v4 AS tl ON tl.target_id = c.id
LEFT JOIN rw_servers AS sv ON sv.id = c.server_id
WHERE tl.target_id IS NULL
   OR COALESCE(sv.plan, 'free') <> 'free'
   OR tl.latest_at > NOW() - INTERVAL '30 days';

CREATE MATERIALIZED VIEW rw_receiver_cursors_v1 AS
SELECT 'user' AS receiver_type, CAST(user_id AS VARCHAR) AS receiver_id, channel_id,
       CAST(last_read_seq AS BIGINT) AS last_read_seq
FROM rw_user_channel_read_cursors_v2
UNION ALL
SELECT 'agent', CAST(agent_id AS VARCHAR), channel_id,
       COALESCE(last_read_seq8, CAST(last_read_seq AS BIGINT))
FROM rw_agent_channel_read_cursors;

CREATE MATERIALIZED VIEW rw_subs_v2 AS
SELECT CASE WHEN c.type = 'dm' THEN 'dm' ELSE 'channel' END AS kind,
       'user' AS receiver_type, CAST(ch.user_id AS VARCHAR) AS receiver_id,
       c.id AS target_id, c.server_id, st.done_at, ch.joined_at
FROM rw_channel_humans ch
JOIN rw_channels c ON ch.channel_id = c.id AND c.type <> 'thread'
 AND c.deleted_at IS NULL AND c.archived_at IS NULL
LEFT JOIN rw_inbox_target_mute_states_v2 mu
  ON mu.receiver_type = 'user' AND mu.receiver_id = CAST(ch.user_id AS VARCHAR)
 AND mu.source_channel_id = c.id AND mu.activity_muted
LEFT JOIN rw_user_channel_inbox_states st
  ON st.user_id = ch.user_id AND st.channel_id = c.id
WHERE mu.receiver_id IS NULL
UNION ALL
SELECT CASE WHEN c.type = 'dm' THEN 'dm' ELSE 'channel' END,
       'agent', CAST(ca.agent_id AS VARCHAR), c.id, c.server_id,
       CAST(NULL AS timestamptz), ca.added_at
FROM rw_channel_agents ca
JOIN rw_channels c ON ca.channel_id = c.id AND c.type <> 'thread'
 AND c.deleted_at IS NULL AND c.archived_at IS NULL
LEFT JOIN rw_inbox_target_mute_states_v2 mu
  ON mu.receiver_type = 'agent' AND mu.receiver_id = CAST(ca.agent_id AS VARCHAR)
 AND mu.source_channel_id = c.id AND mu.activity_muted
WHERE mu.receiver_id IS NULL
UNION ALL
SELECT 'thread', 'user', CAST(tf.follower_id AS VARCHAR), c.id, c.server_id,
       tf.done_at, CAST(NULL AS timestamptz)
FROM rw_thread_follows tf
JOIN rw_channels c ON tf.thread_channel_id = c.id
 AND c.deleted_at IS NULL AND c.archived_at IS NULL
WHERE tf.follower_type = 'user' AND tf.unfollowed_at IS NULL
UNION ALL
SELECT 'thread', 'agent', CAST(tf.follower_id AS VARCHAR), c.id, c.server_id,
       tf.done_at, CAST(NULL AS timestamptz)
FROM rw_thread_follows tf
JOIN rw_channels c ON tf.thread_channel_id = c.id
 AND c.deleted_at IS NULL AND c.archived_at IS NULL
WHERE tf.follower_type = 'agent' AND tf.unfollowed_at IS NULL;

-- NULL TRAP (found by spot-check): written as a bare
--   NOT (message_type='system' AND causal_actor_type=... AND causal_actor_id=...)
-- a system message whose causal actor is NULL yields TRUE AND NULL = NULL, and NOT NULL = NULL,
-- so COUNT(*) FILTER drops it. That silently excluded EVERY system message with a NULL causal
-- actor -- i.e. all history before migration 0279 -- not merely the self-caused ones, which
-- contradicts the ruling that all 22 system-message types keep their current behaviour.
-- COALESCE(..., FALSE) restores the documented intent: NULL means no exclusion applies.
CREATE MATERIALIZED VIEW rw_inbox_normal_v4 AS
SELECT s.kind, s.receiver_type, s.receiver_id, s.target_id, s.server_id, s.done_at, s.joined_at,
       COALESCE(rc.last_read_seq, 0) AS last_read,
       MAX(m.seq) AS latest_seq,
       MAX(m.created_at) AS latest_at,
       COUNT(*) FILTER (WHERE m.seq > COALESCE(rc.last_read_seq, 0)
         AND NOT (m.sender_type = s.receiver_type AND m.sender_id = s.receiver_id)
         AND NOT COALESCE(m.message_type = 'system' AND m.causal_actor_type = s.receiver_type AND m.causal_actor_id = s.receiver_id, FALSE)
         AND (m.system_subtype IS NULL OR m.system_subtype NOT IN ('channel.self_unfollow_thread', 'task.deleted_summary'))
       ) AS unread_count,
       MIN(m.seq) FILTER (WHERE m.seq > COALESCE(rc.last_read_seq, 0)
         AND NOT (m.sender_type = s.receiver_type AND m.sender_id = s.receiver_id)
         AND NOT COALESCE(m.message_type = 'system' AND m.causal_actor_type = s.receiver_type AND m.causal_actor_id = s.receiver_id, FALSE)
         AND (m.system_subtype IS NULL OR m.system_subtype NOT IN ('channel.self_unfollow_thread', 'task.deleted_summary'))
       ) AS first_unread_seq
FROM rw_subs_v2 AS s
JOIN rw_target_eligible_v1 AS g ON g.target_id = s.target_id
LEFT JOIN rw_receiver_cursors_v1 AS rc
  ON rc.receiver_type = s.receiver_type AND rc.receiver_id = s.receiver_id AND rc.channel_id = s.target_id
LEFT JOIN rw_message_target_v3 AS m ON m.target_id = s.target_id
GROUP BY s.kind, s.receiver_type, s.receiver_id, s.target_id, s.server_id, s.done_at, s.joined_at, rc.last_read_seq;

CREATE MATERIALIZED VIEW rw_inbox_mention_v5 AS
WITH proj AS (
  SELECT s.local_channel_id, s.server_id, j.canonical_channel_id
  FROM rw_joint_channel_servers AS s
  JOIN rw_joint_channels AS j ON j.id = s.joint_channel_id
  WHERE s.status = 'active' AND j.status = 'active'
), chan_map AS (
  SELECT c.id AS storage_id, c.id AS target_id FROM rw_channels AS c
  LEFT JOIN proj AS p ON p.local_channel_id = c.id
  WHERE c.deleted_at IS NULL AND c.archived_at IS NULL AND p.local_channel_id IS NULL
  UNION ALL
  SELECT p.canonical_channel_id, p.local_channel_id FROM proj AS p
)
SELECT CASE WHEN c.type = 'thread' THEN 'thread' WHEN c.type = 'dm' THEN 'dm' ELSE 'channel' END AS kind,
       mm.target_type AS receiver_type, CAST(mm.target_id AS VARCHAR) AS receiver_id,
       map.target_id AS target_id, c.server_id,
       COUNT(*) FILTER (WHERE mm.message_seq > COALESCE(rc.last_read_seq, 0)) AS mention_unread,
       MAX(mm.message_seq) FILTER (WHERE mm.message_seq > COALESCE(rc.last_read_seq, 0)) AS max_mention_seq,
       COUNT(*) AS total_mentions
FROM rw_message_mentions_v2 AS mm
JOIN chan_map AS map ON map.storage_id = mm.channel_id
JOIN rw_target_eligible_v1 AS g ON g.target_id = map.target_id
JOIN rw_channels AS c ON c.id = map.target_id AND c.deleted_at IS NULL AND c.archived_at IS NULL
LEFT JOIN rw_channel_humans AS visu ON visu.channel_id = map.target_id AND mm.target_type = 'user' AND CAST(visu.user_id AS VARCHAR) = CAST(mm.target_id AS VARCHAR)
LEFT JOIN rw_channel_agents AS visa ON visa.channel_id = map.target_id AND mm.target_type = 'agent' AND CAST(visa.agent_id AS VARCHAR) = CAST(mm.target_id AS VARCHAR)
LEFT JOIN rw_thread_parent_v3 AS tp ON tp.thread_channel_id = map.target_id
LEFT JOIN rw_channel_humans AS pvisu ON pvisu.channel_id = tp.parent_channel_id AND mm.target_type = 'user' AND CAST(pvisu.user_id AS VARCHAR) = CAST(mm.target_id AS VARCHAR)
LEFT JOIN rw_channel_agents AS pvisa ON pvisa.channel_id = tp.parent_channel_id AND mm.target_type = 'agent' AND CAST(pvisa.agent_id AS VARCHAR) = CAST(mm.target_id AS VARCHAR)
LEFT JOIN rw_thread_follows AS mf ON mf.thread_channel_id = map.target_id AND mf.follower_type = mm.target_type AND CAST(mf.follower_id AS VARCHAR) = CAST(mm.target_id AS VARCHAR) AND mf.unfollowed_at IS NULL
LEFT JOIN rw_receiver_cursors_v1 AS rc ON rc.receiver_type = mm.target_type AND rc.receiver_id = CAST(mm.target_id AS VARCHAR) AND rc.channel_id = map.target_id
WHERE (c.type <> 'thread' AND (visu.user_id IS NOT NULL OR visa.agent_id IS NOT NULL))
   OR (c.type = 'thread' AND (pvisu.user_id IS NOT NULL OR pvisa.agent_id IS NOT NULL OR mf.follower_id IS NOT NULL))
   OR mm.notified_at IS NOT NULL
GROUP BY 1, 2, 3, 4, 5;

CREATE MATERIALIZED VIEW rw_activity_watermark_v4 AS
WITH structural AS (
  SELECT 'user' AS receiver_type, CAST(ch.user_id AS VARCHAR) AS receiver_id, c.id AS target_id
  FROM rw_channel_humans AS ch
  JOIN rw_channels AS c ON ch.channel_id = c.id AND c.type <> 'thread' AND c.deleted_at IS NULL AND c.archived_at IS NULL
  UNION ALL
  SELECT 'agent', CAST(ca.agent_id AS VARCHAR), c.id
  FROM rw_channel_agents AS ca
  JOIN rw_channels AS c ON ca.channel_id = c.id AND c.type <> 'thread' AND c.deleted_at IS NULL AND c.archived_at IS NULL
  UNION ALL
  SELECT tf.follower_type, CAST(tf.follower_id AS VARCHAR), c.id
  FROM rw_thread_follows AS tf
  JOIN rw_channels AS c ON tf.thread_channel_id = c.id AND c.deleted_at IS NULL AND c.archived_at IS NULL
  WHERE tf.unfollowed_at IS NULL
), ranked AS (
  SELECT s.receiver_type, s.receiver_id, tl.latest_seq,
         ROW_NUMBER() OVER (PARTITION BY s.receiver_type, s.receiver_id ORDER BY tl.latest_seq DESC) AS rk
  FROM structural AS s
  JOIN rw_target_latest_v4 AS tl ON tl.target_id = s.target_id
)
SELECT receiver_type, receiver_id, MIN(latest_seq) AS watermark_seq
FROM ranked WHERE rk <= 500
GROUP BY receiver_type, receiver_id;

CREATE MATERIALIZED VIEW rw_inbox_items_v8 AS
WITH sup AS (
  SELECT receiver_type, receiver_id, target_kind, target_channel_id,
         MAX(done_through_seq) AS done_through_seq, MAX(done_at) AS sup_done_at
  FROM rw_inbox_suppression_states
  GROUP BY 1, 2, 3, 4
)
SELECT COALESCE(n.kind, mn.kind) AS kind,
       COALESCE(n.receiver_type, mn.receiver_type) AS receiver_type,
       COALESCE(n.receiver_id, mn.receiver_id) AS receiver_id,
       COALESCE(n.target_id, mn.target_id) AS target_id,
       COALESCE(n.server_id, mn.server_id) AS server_id,
       n.unread_count, n.first_unread_seq, n.latest_seq, n.latest_at,
       n.last_read AS last_read_seq,
       COALESCE(mn.mention_unread, 0) AS mention_unread,
       mn.max_mention_seq,
       COALESCE(mn.total_mentions, 0) AS total_mentions,
       ((n.receiver_id IS NOT NULL AND n.latest_seq IS NOT NULL
         AND (n.done_at IS NULL OR n.latest_at > n.done_at)
         AND (n.joined_at IS NULL OR n.latest_at > n.joined_at)
         AND (sn.receiver_id IS NULL
           OR (sn.done_through_seq IS NOT NULL AND n.latest_seq > sn.done_through_seq)
           OR (sn.done_through_seq IS NULL AND n.latest_at > sn.sup_done_at)))
        OR (COALESCE(mn.mention_unread, 0) > 0 AND n.receiver_id IS NULL
         AND (sm.receiver_id IS NULL
           OR (sm.done_through_seq IS NOT NULL AND mn.max_mention_seq > sm.done_through_seq)))) AS present
FROM rw_inbox_normal_v4 AS n
FULL JOIN rw_inbox_mention_v5 AS mn
  ON n.kind = mn.kind AND n.receiver_type = mn.receiver_type AND n.receiver_id = mn.receiver_id AND n.target_id = mn.target_id
LEFT JOIN sup AS sn
  ON sn.receiver_type = n.receiver_type AND sn.receiver_id = n.receiver_id AND sn.target_channel_id = n.target_id
 AND sn.target_kind = CASE n.kind WHEN 'thread' THEN 'followed_thread' WHEN 'dm' THEN 'dm' ELSE 'channel' END
LEFT JOIN sup AS sm
  ON sm.receiver_type = mn.receiver_type AND sm.receiver_id = mn.receiver_id AND sm.target_channel_id = mn.target_id
 AND sm.target_kind = CASE mn.kind WHEN 'thread' THEN 'public_thread_mention' WHEN 'dm' THEN 'dm' ELSE 'public_channel_mention' END;

CREATE MATERIALIZED VIEW rw_inbox_serving_v4 AS
SELECT p.server_id, p.receiver_type, p.receiver_id, p.kind,
       CASE WHEN p.kind = 'thread' THEN NULL ELSE p.target_id END AS channel_id,
       CASE WHEN p.kind = 'thread' THEN NULL ELSE c.name END AS channel_name,
       CASE WHEN p.kind = 'thread' THEN NULL ELSE c.type END AS channel_type,
       lm.id AS last_message_id,
       fu.id AS first_unread_message_id,
       CASE WHEN p.kind = 'thread' THEN NULL ELSE p.latest_at END AS last_message_at,
       CASE WHEN p.kind = 'thread' THEN NULL ELSE lm.preview END AS last_message_preview,
       CASE WHEN p.kind = 'thread' THEN NULL ELSE lm.sender_type END AS last_message_sender_type,
       CASE WHEN p.kind = 'thread' THEN NULL ELSE lm.sender_id END AS last_message_sender_id,
       CAST(COALESCE(p.unread_count, 0) AS INT) AS unread_count,
       CASE WHEN p.kind = 'thread' THEN p.target_id ELSE NULL END AS thread_channel_id,
       tp.parent_message_id, tp.parent_channel_id, tp.parent_channel_name, tp.parent_channel_type,
       pm.preview AS parent_message_preview, pm.sender_type AS parent_message_sender_type, pm.sender_id AS parent_message_sender_id,
       COALESCE(lm.preview, ma.preview) AS latest_activity_preview,
       COALESCE(lm.sender_type, ma.sender_type) AS latest_activity_sender_type,
       COALESCE(lm.sender_id, ma.sender_id) AS latest_activity_sender_id,
       COALESCE(lm.id, ma.id) AS latest_activity_message_id,
       p.latest_at AS last_activity_at,
       CASE WHEN p.kind = 'thread' THEN p.latest_at ELSE NULL END AS last_reply_at,
       CASE WHEN p.kind = 'thread' THEN CAST(tl.msg_count AS INT) ELSE NULL END AS reply_count,
       pm.task_number, pm.task_status, pm.task_assignee_type AS task_claimed_by_type, pm.task_assignee_id AS task_claimed_by_id,
       (p.mention_unread > 0) AS has_mention,
       (p.mention_unread > 0 AND p.unread_count IS NULL) AS mention_only,
       CAST(p.last_read_seq AS BIGINT) AS last_read_seq,
       COALESCE(p.latest_at, ma.created_at) AS activity_at,
       (p.total_mentions > 0) AS has_any_mention
FROM rw_inbox_items_v8 AS p
LEFT JOIN rw_activity_watermark_v4 AS w ON w.receiver_type = p.receiver_type AND w.receiver_id = p.receiver_id
LEFT JOIN rw_channels AS c ON c.id = p.target_id
LEFT JOIN rw_message_preview_v1 AS lm ON lm.seq = p.latest_seq
LEFT JOIN rw_message_preview_v1 AS fu ON fu.seq = p.first_unread_seq
LEFT JOIN rw_thread_parent_v3 AS tp ON tp.thread_channel_id = p.target_id AND p.kind = 'thread'
LEFT JOIN rw_message_preview_v1 AS pm ON pm.id = tp.parent_message_id
LEFT JOIN rw_target_latest_v4 AS tl ON tl.target_id = p.target_id
LEFT JOIN rw_message_preview_v1 AS ma ON ma.seq = p.max_mention_seq
-- plan/recency filtering now happens once, upstream, in rw_target_eligible_v1.
WHERE p.present
  AND GREATEST(COALESCE(p.latest_seq, 0), COALESCE(p.max_mention_seq, 0)) >= COALESCE(w.watermark_seq, 0);

CREATE INDEX idx_rw_inbox_serving_v4_receiver ON rw_inbox_serving_v4 (receiver_type, receiver_id, activity_at DESC);

CREATE MATERIALIZED VIEW rw_activity_totals_v2 AS
SELECT i.receiver_type, i.receiver_id, i.server_id,
       CAST(COALESCE(SUM(CASE WHEN i.mention_only THEN 0 ELSE i.unread_count END), 0) AS INT) AS total_unread_count
FROM rw_inbox_serving_v4 AS i
WHERE (i.kind = 'thread' OR i.channel_type IN ('channel', 'private', 'joint', 'dm'))
GROUP BY i.receiver_type, i.receiver_id, i.server_id;
