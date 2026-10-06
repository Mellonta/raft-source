-- RFC-063 unified chain, generation v5. Three semantic corrections, no new large fan-out.
--
-- 1. MUTE ACTS AT ADMISSION. v4 dropped a muted channel/DM subscription whole
--    (rw_subs_v2: WHERE mu.receiver_id IS NULL), which also discarded the unread
--    that arrived BEFORE the mute. The product rule (inboxMutePolicy.ts
--    isActivityPromotionSuppressedByMute) suppresses only seq >= mute_from_seq, and
--    RFC-064 states the same thing as "mute acts at admission". v5 keeps
--    rw_inbox_normal_v4 (unmuted subscriptions, unchanged) and adds the muted
--    subscriptions as a second, disjoint arm that admits only seq < mute_from_seq.
--    Personal mentions still pierce through rw_inbox_mention_v5, unchanged.
--    Muted subscriptions fan out to roughly an order of magnitude fewer
--    subscription x message pairs than the normal arm, so the new arm is cheap.
--
-- 2. THE WATERMARK IS PER (receiver, server). v4 took the 500-latest-targets cutoff
--    across ALL of a receiver's servers, so a busy server hid an older server's rows
--    from that server's Activity (and from its badge, which sums the served rows).
--    This hid real rows (and their unread) for users active on several servers.
--    Activity is read per server, so the bound is too.
--
-- 3. A TOTALS ROW EXISTS FOR EVERY (user, server) MEMBERSHIP. v4 totals only had a
--    row where the user had served rows, so the reader initialised a missing row to
--    0 and could not tell "nothing unread" from "not materialized". v5 carries a row
--    for every server member (0 when nothing is served); a missing row now means the
--    membership itself has not reached RisingWave, which the reader can surface.
--
-- Everything else is v4 verbatim: same predicates, same column shapes (serving v5 ==
-- serving v4 column-for-column, so the server reads it by changing the view name).

CREATE MATERIALIZED VIEW rw_muted_subs_v1 AS
SELECT CASE WHEN c.type = 'dm' THEN 'dm' ELSE 'channel' END AS kind,
       'user' AS receiver_type, CAST(ch.user_id AS VARCHAR) AS receiver_id,
       c.id AS target_id, c.server_id, st.done_at, ch.joined_at, mu.mute_from_seq
FROM rw_channel_humans ch
JOIN rw_channels c ON ch.channel_id = c.id AND c.type <> 'thread'
 AND c.deleted_at IS NULL AND c.archived_at IS NULL
JOIN rw_inbox_target_mute_states_v2 mu
  ON mu.receiver_type = 'user' AND mu.receiver_id = CAST(ch.user_id AS VARCHAR)
 AND mu.source_channel_id = c.id AND mu.activity_muted
LEFT JOIN rw_user_channel_inbox_states st
  ON st.user_id = ch.user_id AND st.channel_id = c.id
UNION ALL
SELECT CASE WHEN c.type = 'dm' THEN 'dm' ELSE 'channel' END,
       'agent', CAST(ca.agent_id AS VARCHAR), c.id, c.server_id,
       CAST(NULL AS timestamptz), ca.added_at, mu.mute_from_seq
FROM rw_channel_agents ca
JOIN rw_channels c ON ca.channel_id = c.id AND c.type <> 'thread'
 AND c.deleted_at IS NULL AND c.archived_at IS NULL
JOIN rw_inbox_target_mute_states_v2 mu
  ON mu.receiver_type = 'agent' AND mu.receiver_id = CAST(ca.agent_id AS VARCHAR)
 AND mu.source_channel_id = c.id AND mu.activity_muted;

-- Same aggregate as rw_inbox_normal_v4, over admitted messages only. A NULL
-- mute_from_seq admits everything (the policy suppresses nothing without a boundary).
-- INNER JOIN on purpose: a muted subscription with nothing admitted must have NO
-- normal-arm row, so a mention after the mute still surfaces as mention-only.
CREATE MATERIALIZED VIEW rw_inbox_muted_prefix_v1 AS
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
FROM rw_muted_subs_v1 AS s
JOIN rw_target_eligible_v1 AS g ON g.target_id = s.target_id
LEFT JOIN rw_receiver_cursors_v1 AS rc
  ON rc.receiver_type = s.receiver_type AND rc.receiver_id = s.receiver_id AND rc.channel_id = s.target_id
JOIN rw_message_target_v3 AS m
  ON m.target_id = s.target_id AND (s.mute_from_seq IS NULL OR m.seq < s.mute_from_seq)
GROUP BY s.kind, s.receiver_type, s.receiver_id, s.target_id, s.server_id, s.done_at, s.joined_at, rc.last_read_seq;

CREATE MATERIALIZED VIEW rw_activity_watermark_v5 AS
WITH structural AS (
  SELECT 'user' AS receiver_type, CAST(ch.user_id AS VARCHAR) AS receiver_id, c.id AS target_id, c.server_id
  FROM rw_channel_humans AS ch
  JOIN rw_channels AS c ON ch.channel_id = c.id AND c.type <> 'thread' AND c.deleted_at IS NULL AND c.archived_at IS NULL
  UNION ALL
  SELECT 'agent', CAST(ca.agent_id AS VARCHAR), c.id, c.server_id
  FROM rw_channel_agents AS ca
  JOIN rw_channels AS c ON ca.channel_id = c.id AND c.type <> 'thread' AND c.deleted_at IS NULL AND c.archived_at IS NULL
  UNION ALL
  SELECT tf.follower_type, CAST(tf.follower_id AS VARCHAR), c.id, c.server_id
  FROM rw_thread_follows AS tf
  JOIN rw_channels AS c ON tf.thread_channel_id = c.id AND c.deleted_at IS NULL AND c.archived_at IS NULL
  WHERE tf.unfollowed_at IS NULL
), ranked AS (
  SELECT s.receiver_type, s.receiver_id, s.server_id, tl.latest_seq,
         ROW_NUMBER() OVER (PARTITION BY s.receiver_type, s.receiver_id, s.server_id ORDER BY tl.latest_seq DESC) AS rk
  FROM structural AS s
  JOIN rw_target_latest_v4 AS tl ON tl.target_id = s.target_id
)
-- Only a partition that actually HAS 500 targets gets a cutoff: the watermark exists to
-- cap the list at 500 targets, so below that nothing is trimmed. v4 emitted MIN over
-- whatever was there, which with fewer than 500 targets is simply the oldest target --
-- and that trimmed mention-only rows (threads the receiver does not follow are not
-- targets) older than it. Per server this bit far more often than globally (a
-- first v5 build without this guard hid rows that v4 showed).
SELECT receiver_type, receiver_id, server_id, MIN(latest_seq) AS watermark_seq
FROM ranked WHERE rk <= 500
GROUP BY receiver_type, receiver_id, server_id
HAVING COUNT(*) >= 500;

CREATE MATERIALIZED VIEW rw_inbox_items_v9 AS
WITH n AS (
  SELECT kind, receiver_type, receiver_id, target_id, server_id, done_at, joined_at,
         last_read, latest_seq, latest_at, unread_count, first_unread_seq
  FROM rw_inbox_normal_v4
  UNION ALL
  SELECT kind, receiver_type, receiver_id, target_id, server_id, done_at, joined_at,
         last_read, latest_seq, latest_at, unread_count, first_unread_seq
  FROM rw_inbox_muted_prefix_v1
), sup AS (
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
        -- A mention the admitted stream does not cover stands on its own. For an
        -- unmuted subscription every mention is inside the normal arm (latest_seq >=
        -- max_mention_seq), exactly v4's "n absent". For a muted one the arm stops at
        -- mute_from_seq, so a mention that pierced the mute is beyond it.
        OR (COALESCE(mn.mention_unread, 0) > 0
         AND (n.receiver_id IS NULL OR mn.max_mention_seq > COALESCE(n.latest_seq, 0))
         AND (sm.receiver_id IS NULL
           OR (sm.done_through_seq IS NOT NULL AND mn.max_mention_seq > sm.done_through_seq)))) AS present
FROM n
FULL JOIN rw_inbox_mention_v5 AS mn
  ON n.kind = mn.kind AND n.receiver_type = mn.receiver_type AND n.receiver_id = mn.receiver_id AND n.target_id = mn.target_id
LEFT JOIN sup AS sn
  ON sn.receiver_type = n.receiver_type AND sn.receiver_id = n.receiver_id AND sn.target_channel_id = n.target_id
 AND sn.target_kind = CASE n.kind WHEN 'thread' THEN 'followed_thread' WHEN 'dm' THEN 'dm' ELSE 'channel' END
LEFT JOIN sup AS sm
  ON sm.receiver_type = mn.receiver_type AND sm.receiver_id = mn.receiver_id AND sm.target_channel_id = mn.target_id
 AND sm.target_kind = CASE mn.kind WHEN 'thread' THEN 'public_thread_mention' WHEN 'dm' THEN 'dm' ELSE 'public_channel_mention' END;

CREATE MATERIALIZED VIEW rw_inbox_serving_v5 AS
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
       -- The seq of latest_activity_message_id, carried here so readers never look it
       -- up in rw_messages at query time: that random-id lookup, cold in the block
       -- cache, dominated the tail latency of the Activity list (first-run reads were
       -- orders of magnitude slower with the lookup than without it).
       COALESCE(lm.seq, ma.seq) AS latest_activity_seq,
       p.latest_at AS last_activity_at,
       CASE WHEN p.kind = 'thread' THEN p.latest_at ELSE NULL END AS last_reply_at,
       CASE WHEN p.kind = 'thread' THEN CAST(tl.msg_count AS INT) ELSE NULL END AS reply_count,
       pm.task_number, pm.task_status, pm.task_assignee_type AS task_claimed_by_type, pm.task_assignee_id AS task_claimed_by_id,
       (p.mention_unread > 0) AS has_mention,
       (p.mention_unread > 0 AND p.unread_count IS NULL) AS mention_only,
       CAST(p.last_read_seq AS BIGINT) AS last_read_seq,
       COALESCE(p.latest_at, ma.created_at) AS activity_at,
       (p.total_mentions > 0) AS has_any_mention
FROM rw_inbox_items_v9 AS p
LEFT JOIN rw_activity_watermark_v5 AS w
  ON w.receiver_type = p.receiver_type AND w.receiver_id = p.receiver_id AND w.server_id = p.server_id
LEFT JOIN rw_channels AS c ON c.id = p.target_id
LEFT JOIN rw_message_preview_v1 AS lm ON lm.seq = p.latest_seq
LEFT JOIN rw_message_preview_v1 AS fu ON fu.seq = p.first_unread_seq
LEFT JOIN rw_thread_parent_v3 AS tp ON tp.thread_channel_id = p.target_id AND p.kind = 'thread'
LEFT JOIN rw_message_preview_v1 AS pm ON pm.id = tp.parent_message_id
LEFT JOIN rw_target_latest_v4 AS tl ON tl.target_id = p.target_id
LEFT JOIN rw_message_preview_v1 AS ma ON ma.seq = p.max_mention_seq
-- The watermark ranks TARGETS by their latest message (rw_target_latest_v4), so the
-- row is compared by the same quantity. v4 compared the row's own latest/mention seq,
-- which dropped a mention-only row whose mention is older than the cutoff while its
-- target is inside the 500.
WHERE p.present
  AND GREATEST(COALESCE(tl.latest_seq, 0), COALESCE(p.latest_seq, 0), COALESCE(p.max_mention_seq, 0)) >= COALESCE(w.watermark_seq, 0);

CREATE INDEX idx_rw_inbox_serving_v5_receiver ON rw_inbox_serving_v5 (receiver_type, receiver_id, activity_at DESC);

-- Every (user, server) membership has a row, 0 when nothing is served. Served rows
-- for a (user, server) that is not a membership (e.g. a DM or joint projection on a
-- server the user is not a member of) are kept exactly as v2 counted them. Agents
-- have rows only where something is served (there is no agent membership mirror).
CREATE MATERIALIZED VIEW rw_activity_totals_v3 AS
WITH served AS (
  SELECT i.receiver_type, i.receiver_id, i.server_id,
         CAST(COALESCE(SUM(CASE WHEN i.mention_only THEN 0 ELSE i.unread_count END), 0) AS INT) AS total_unread_count
  FROM rw_inbox_serving_v5 AS i
  WHERE (i.kind = 'thread' OR i.channel_type IN ('channel', 'private', 'joint', 'dm'))
  GROUP BY i.receiver_type, i.receiver_id, i.server_id
), members AS (
  SELECT 'user' AS receiver_type, CAST(user_id AS VARCHAR) AS receiver_id, server_id
  FROM rw_server_members
)
SELECT COALESCE(m.receiver_type, s.receiver_type) AS receiver_type,
       COALESCE(m.receiver_id, s.receiver_id) AS receiver_id,
       COALESCE(m.server_id, s.server_id) AS server_id,
       COALESCE(s.total_unread_count, 0) AS total_unread_count
FROM members AS m
FULL JOIN served AS s
  ON s.receiver_type = m.receiver_type AND s.receiver_id = m.receiver_id AND s.server_id = m.server_id;

-- Agent recovery view over the v5 arms (supersedes rw_agent_inbox_v1, which read
-- rw_inbox_normal_v4 alone and so dropped a muted channel's pre-mute unread).
CREATE MATERIALIZED VIEW rw_agent_inbox_v2 AS
WITH proj AS (
  SELECT s.local_channel_id, j.canonical_channel_id
  FROM rw_joint_channel_servers AS s
  JOIN rw_joint_channels AS j ON j.id = s.joint_channel_id
  WHERE s.status = 'active' AND j.status = 'active'
), n AS (
  SELECT kind, receiver_id, target_id, server_id, unread_count, first_unread_seq, latest_seq
  FROM rw_inbox_normal_v4 WHERE receiver_type = 'agent'
  UNION ALL
  SELECT kind, receiver_id, target_id, server_id, unread_count, first_unread_seq, latest_seq
  FROM rw_inbox_muted_prefix_v1 WHERE receiver_type = 'agent'
), u AS (
  SELECT COALESCE(n.kind, mn.kind) AS kind,
         COALESCE(n.receiver_id, mn.receiver_id) AS agent_id,
         COALESCE(n.target_id, mn.target_id) AS target_id,
         COALESCE(n.server_id, mn.server_id) AS server_id,
         COALESCE(n.unread_count, 0) AS unread_count,
         n.first_unread_seq, n.latest_seq,
         COALESCE(mn.mention_unread, 0) AS mention_unread,
         mn.max_mention_seq,
         (n.receiver_id IS NOT NULL) AS subscribed
  FROM n
  FULL JOIN (SELECT * FROM rw_inbox_mention_v5 WHERE receiver_type = 'agent') AS mn
    ON n.kind = mn.kind AND n.receiver_id = mn.receiver_id AND n.target_id = mn.target_id
  WHERE COALESCE(n.unread_count, 0) > 0 OR COALESCE(mn.mention_unread, 0) > 0
)
SELECT u.agent_id, u.server_id, u.kind, u.target_id,
       COALESCE(p.canonical_channel_id, u.target_id) AS storage_channel_id,
       c.name AS channel_name, c.type AS channel_type, c.parent_message_id,
       tp.parent_channel_id, tp.parent_channel_name, tp.parent_channel_type,
       CAST(COALESCE(rc.last_read_seq, 0) AS BIGINT) AS last_read_seq,
       u.unread_count, u.first_unread_seq, u.latest_seq,
       u.mention_unread, u.max_mention_seq, u.subscribed,
       CASE WHEN u.kind = 'thread' THEN tf.created_at ELSE ca.added_at END AS joined_at
FROM u
JOIN rw_channels AS c ON c.id = u.target_id
LEFT JOIN proj AS p ON p.local_channel_id = u.target_id
LEFT JOIN rw_thread_parent_v3 AS tp ON tp.thread_channel_id = u.target_id AND u.kind = 'thread'
LEFT JOIN rw_receiver_cursors_v1 AS rc
  ON rc.receiver_type = 'agent' AND rc.receiver_id = u.agent_id AND rc.channel_id = u.target_id
LEFT JOIN rw_channel_agents AS ca
  ON ca.channel_id = u.target_id AND CAST(ca.agent_id AS VARCHAR) = u.agent_id AND u.kind <> 'thread'
LEFT JOIN rw_thread_follows AS tf
  ON tf.thread_channel_id = u.target_id AND tf.follower_type = 'agent'
 AND CAST(tf.follower_id AS VARCHAR) = u.agent_id AND tf.unfollowed_at IS NULL AND u.kind = 'thread';

CREATE INDEX idx_rw_agent_inbox_v2_agent ON rw_agent_inbox_v2 (agent_id);
