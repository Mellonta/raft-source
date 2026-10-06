-- Agent inbox: the unified chain's per-(agent, target) unread, for agent resume recovery.
--
-- STATUS: second half of RFC-063 Stage 3 (agents). Built on every cluster before any code
-- reads it; read only behind the risingwave_agent_inbox_v0 flag.
--
-- WHY THIS IS NOT A NEW FAN-OUT. Agent subscriptions already account for most of the
-- (subscription x message) pairs aggregated by rw_inbox_normal_v4. This view only filters
-- that aggregate (and the mention arm) to agents and
-- attaches point lookups: read position, join time, joint storage, thread parent. It adds
-- no per-message state.
--
-- SEMANTICS are the 063 chain's (self and causal-actor exclusion, noise subtypes, mute at
-- admission, archived excluded, free-plan eligibility per target), NOT the Postgres recovery
-- predicate's. Differences that remain on purpose are listed in the PR. Two that the reader
-- must handle:
--   * joined_at is NULL when the row exists only because of a notified mention in a thread
--     the agent does not follow or a channel it is not a member of. Recovery ignores those.
--   * unread_count does not exclude messages sent before the agent joined (the chain has no
--     join bound for agents). Rows are re-read from Postgres with that bound, so delivered
--     content is unaffected; only the unread summary can over-count.
CREATE MATERIALIZED VIEW rw_agent_inbox_v1 AS
WITH proj AS (
  SELECT s.local_channel_id, j.canonical_channel_id
  FROM rw_joint_channel_servers AS s
  JOIN rw_joint_channels AS j ON j.id = s.joint_channel_id
  WHERE s.status = 'active' AND j.status = 'active'
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
  FROM (SELECT * FROM rw_inbox_normal_v4 WHERE receiver_type = 'agent') AS n
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

-- Serving lookup is by agent.
CREATE INDEX idx_rw_agent_inbox_v1_agent ON rw_agent_inbox_v1 (agent_id);
