-- SUPERSEDED READER VIEW: rw_conversation_unread_v1 sits on rw_inbox_mention_v5,
-- which drops joint mentions (see 067-mention-v6.sql). The server reads
-- rw_conversation_unread_v2 (068-chain-mention-v6-consumers.sql), which is this
-- definition on rw_inbox_mention_v6. rw_inbox_muted_full_v1 below is still live:
-- v2 reads it unchanged.
--
-- Sidebar unread per (receiver, conversation), a projection of the unified chain.
-- Rules live in the chain arms (rw_inbox_normal_v4 / rw_inbox_mention_v5 /
-- rw_receiver_cursors_v1); this view adds only what the sidebar needs beyond
-- Activity: muted conversations (full count, quiet display) and read-state fields.

-- Muted subscriptions with the SAME aggregate as rw_inbox_normal_v4 (no mute-seq
-- cut: the sidebar shows a muted conversation's full unread count quietly).
CREATE MATERIALIZED VIEW rw_inbox_muted_full_v1 AS
SELECT s.kind, s.receiver_type, s.receiver_id, s.target_id, s.server_id, s.done_at, s.joined_at,
       COALESCE(rc.last_read_seq, 0) AS last_read,
       MAX(m.seq) AS latest_seq,
       MAX(m.created_at) AS latest_at,
       COUNT(*) FILTER (WHERE m.seq > COALESCE(rc.last_read_seq, 0)
         AND NOT (m.sender_type = s.receiver_type AND m.sender_id = s.receiver_id)
         AND NOT COALESCE(m.message_type = 'system' AND m.causal_actor_type = s.receiver_type AND m.causal_actor_id = s.receiver_id, FALSE)
         AND (m.system_subtype IS NULL OR m.system_subtype NOT IN ('channel.self_unfollow_thread', 'task.deleted_summary'))
       ) AS unread_count
FROM rw_muted_subs_v1 AS s
JOIN rw_target_eligible_v1 AS g ON g.target_id = s.target_id
LEFT JOIN rw_receiver_cursors_v1 AS rc
  ON rc.receiver_type = s.receiver_type AND rc.receiver_id = s.receiver_id AND rc.channel_id = s.target_id
LEFT JOIN rw_message_target_v3 AS m ON m.target_id = s.target_id
GROUP BY s.kind, s.receiver_type, s.receiver_id, s.target_id, s.server_id, s.done_at, s.joined_at, rc.last_read_seq;

CREATE MATERIALIZED VIEW rw_conversation_unread_v1 AS
WITH subs AS (
  SELECT kind, receiver_type, receiver_id, target_id, server_id, done_at, latest_seq, unread_count
  FROM rw_inbox_normal_v4
  UNION ALL
  SELECT kind, receiver_type, receiver_id, target_id, server_id, done_at, latest_seq, unread_count
  FROM rw_inbox_muted_full_v1
), u AS (
  SELECT COALESCE(n.kind, mn.kind) AS kind,
         COALESCE(n.receiver_type, mn.receiver_type) AS receiver_type,
         COALESCE(n.receiver_id, mn.receiver_id) AS receiver_id,
         COALESCE(n.target_id, mn.target_id) AS target_id,
         COALESCE(n.server_id, mn.server_id) AS server_id,
         (n.receiver_id IS NOT NULL) AS subscribed,
         n.done_at,
         n.latest_seq,
         COALESCE(n.unread_count, 0) AS unread_count,
         COALESCE(mn.mention_unread, 0) AS mention_unread,
         COALESCE(mn.total_mentions, 0) AS total_mentions
  FROM subs AS n
  FULL JOIN rw_inbox_mention_v5 AS mn
    ON mn.receiver_type = n.receiver_type AND mn.receiver_id = n.receiver_id AND mn.target_id = n.target_id
)
SELECT u.receiver_type, u.receiver_id, u.server_id, u.target_id, u.kind, u.subscribed,
       u.unread_count, u.mention_unread, u.total_mentions,
       COALESCE(u.latest_seq, tl.latest_seq) AS latest_seq,
       lm.id AS latest_message_id,
       (COALESCE(uc.user_id, ac.agent_id) IS NOT NULL) AS cursor_present,
       COALESCE(CAST(uc.last_read_seq AS BIGINT), ac.last_read_seq8, CAST(ac.last_read_seq AS BIGINT)) AS last_read_seq,
       COALESCE(uc.read_state_version, ac.read_state_version) AS read_state_version
FROM u
LEFT JOIN rw_target_latest_v4 AS tl ON tl.target_id = u.target_id
LEFT JOIN rw_message_preview_v1 AS lm ON lm.seq = COALESCE(u.latest_seq, tl.latest_seq)
LEFT JOIN rw_user_channel_read_cursors_v2 AS uc
  ON u.receiver_type = 'user' AND CAST(uc.user_id AS VARCHAR) = u.receiver_id AND uc.channel_id = u.target_id
LEFT JOIN rw_agent_channel_read_cursors AS ac
  ON u.receiver_type = 'agent' AND CAST(ac.agent_id AS VARCHAR) = u.receiver_id AND ac.channel_id = u.target_id
LEFT JOIN rw_thread_parent_v3 AS tp ON tp.thread_channel_id = u.target_id AND u.kind = 'thread'
LEFT JOIN rw_channels AS pc ON pc.id = tp.parent_channel_id
LEFT JOIN rw_channel_humans AS pch
  ON u.receiver_type = 'user' AND pch.channel_id = tp.parent_channel_id AND CAST(pch.user_id AS VARCHAR) = u.receiver_id
LEFT JOIN rw_channel_agents AS pca
  ON u.receiver_type = 'agent' AND pca.channel_id = tp.parent_channel_id AND CAST(pca.agent_id AS VARCHAR) = u.receiver_id
-- A thread has a sidebar slot only while followed and not done, under a live parent
-- the receiver can see (public, or a member of private/DM/joint parent).
WHERE u.kind <> 'thread'
   OR (u.subscribed AND u.done_at IS NULL
       AND pc.id IS NOT NULL AND pc.deleted_at IS NULL AND pc.archived_at IS NULL
       AND (pc.type = 'channel' OR pch.user_id IS NOT NULL OR pca.agent_id IS NOT NULL));

CREATE INDEX idx_rw_conversation_unread_v1_receiver
  ON rw_conversation_unread_v1 (receiver_type, receiver_id, server_id);
