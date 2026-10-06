-- rw_agent_inbox_v4: v3 plus the human rule for mentions that pierce a mute (rw_inbox_items_v9):
-- a conversation whose muted prefix is read but that has a later @mention is offered.
-- rw_agent_inbox_v3 header follows.
-- rw_agent_inbox_v3: the agent inbox as the rows recovery / inbox check actually offer.
-- Differences from rw_agent_inbox_v2 (063-chain-v5.sql), all moved from app code into the view:
--   * only OFFERED rows: joined (membership / active follow) and, subscribed ? unread : mention unread;
--   * thread rows only when the agent can receive the thread: parent is a joint local
--     projection / private channel / DM the agent belongs to, or a public channel of the
--     agent's server (the row's server); thread and parent not deleted;
--   * parent_message_id = the canonical parent for joint local threads (was NULL);
--   * activity_seq = GREATEST(latest_seq, max_mention_seq) and offered_unread as columns, and an
--     index on (agent_id, activity_seq DESC) so a page is one index range scan.
CREATE MATERIALIZED VIEW rw_agent_inbox_v4 AS
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
  -- A mention the admitted stream does not cover stands on its own (the same rule
  -- as rw_inbox_items_v9 for humans): for a muted subscription the normal arm stops
  -- at mute_from_seq, so a mention that pierced the mute lies beyond latest_seq.
  WHERE (n.receiver_id IS NOT NULL AND COALESCE(n.unread_count, 0) > 0)
     OR (COALESCE(mn.mention_unread, 0) > 0
         AND (n.receiver_id IS NULL OR mn.max_mention_seq > COALESCE(n.latest_seq, 0)))
)
SELECT u.agent_id, u.server_id, u.kind, u.target_id,
       COALESCE(p.canonical_channel_id, u.target_id) AS storage_channel_id,
       c.name AS channel_name, c.type AS channel_type,
       COALESCE(tp.parent_message_id, c.parent_message_id) AS parent_message_id,
       tp.parent_channel_id, tp.parent_channel_name, tp.parent_channel_type,
       CAST(COALESCE(rc.last_read_seq, 0) AS BIGINT) AS last_read_seq,
       u.unread_count, u.first_unread_seq, u.latest_seq,
       u.mention_unread, u.max_mention_seq, u.subscribed,
       -- A pierced mention beyond the admitted stream counts as (at least) one more.
       CASE WHEN u.subscribed
            THEN u.unread_count + CASE WHEN u.mention_unread > 0 AND u.max_mention_seq > COALESCE(u.latest_seq, 0) THEN 1 ELSE 0 END
            ELSE u.mention_unread END AS offered_unread,
       GREATEST(COALESCE(u.latest_seq, 0), COALESCE(u.max_mention_seq, 0)) AS activity_seq,
       CASE WHEN u.kind = 'thread' THEN tf.created_at ELSE ca.added_at END AS joined_at
FROM u
JOIN rw_channels AS c ON c.id = u.target_id AND c.deleted_at IS NULL
LEFT JOIN proj AS p ON p.local_channel_id = u.target_id
LEFT JOIN rw_thread_parent_v3 AS tp ON tp.thread_channel_id = u.target_id AND u.kind = 'thread'
LEFT JOIN rw_channels AS pc ON pc.id = tp.parent_channel_id AND pc.deleted_at IS NULL
LEFT JOIN rw_channel_agents AS pca
  ON pca.channel_id = tp.parent_channel_id AND CAST(pca.agent_id AS VARCHAR) = u.agent_id
LEFT JOIN rw_receiver_cursors_v1 AS rc
  ON rc.receiver_type = 'agent' AND rc.receiver_id = u.agent_id AND rc.channel_id = u.target_id
LEFT JOIN rw_channel_agents AS ca
  ON ca.channel_id = u.target_id AND CAST(ca.agent_id AS VARCHAR) = u.agent_id AND u.kind <> 'thread'
LEFT JOIN rw_thread_follows AS tf
  ON tf.thread_channel_id = u.target_id AND tf.follower_type = 'agent'
 AND CAST(tf.follower_id AS VARCHAR) = u.agent_id AND tf.unfollowed_at IS NULL AND u.kind = 'thread'
WHERE (CASE WHEN u.kind = 'thread' THEN tf.created_at ELSE ca.added_at END) IS NOT NULL
  AND (u.kind <> 'thread' OR (
        pc.id IS NOT NULL
        AND (pca.agent_id IS NOT NULL OR (pc.type = 'channel' AND pc.server_id = u.server_id))
      ));

CREATE INDEX idx_rw_agent_inbox_v4_agent_activity ON rw_agent_inbox_v4 (agent_id, activity_seq DESC);
