-- Mention arm v6: a mention belongs to the conversation its MESSAGE is stored in.
-- message_mentions.channel_id for a cross-server (joint) conversation is the
-- SENDER's local projection id, while the message lives in canonical storage;
-- v5 keyed mentions by that raw id and dropped every one of them (a large and
-- growing set). v6 first maps any projection id to its canonical storage, then
-- fans storage out to local targets like every other arm. A projected target is
-- membership-gated (joint conversations have no outsider visibility), so the
-- notified-outsider admission applies only to unprojected conversations; this
-- also keeps a mention from surfacing on a server where the receiver cannot see
-- the conversation.
CREATE MATERIALIZED VIEW rw_inbox_mention_v6 AS
WITH proj AS (
  SELECT s.local_channel_id, s.server_id, j.canonical_channel_id
  FROM rw_joint_channel_servers AS s
  JOIN rw_joint_channels AS j ON j.id = s.joint_channel_id
  WHERE s.status = 'active' AND j.status = 'active'
), chan_map AS (
  SELECT c.id AS storage_id, c.id AS target_id, FALSE AS projected
  FROM rw_channels AS c
  LEFT JOIN proj AS p ON p.local_channel_id = c.id
  WHERE c.deleted_at IS NULL AND c.archived_at IS NULL AND p.local_channel_id IS NULL
  UNION ALL
  SELECT p.canonical_channel_id, p.local_channel_id, TRUE FROM proj AS p
), mm AS (
  SELECT m.*, COALESCE(pj.canonical_channel_id, m.channel_id) AS storage_id
  FROM rw_message_mentions_v2 AS m
  LEFT JOIN proj AS pj ON pj.local_channel_id = m.channel_id
)
SELECT CASE WHEN c.type = 'thread' THEN 'thread' WHEN c.type = 'dm' THEN 'dm' ELSE 'channel' END AS kind,
       mm.target_type AS receiver_type, CAST(mm.target_id AS VARCHAR) AS receiver_id,
       map.target_id AS target_id, c.server_id,
       COUNT(*) FILTER (WHERE mm.message_seq > COALESCE(rc.last_read_seq, 0)) AS mention_unread,
       MAX(mm.message_seq) FILTER (WHERE mm.message_seq > COALESCE(rc.last_read_seq, 0)) AS max_mention_seq,
       COUNT(*) AS total_mentions
FROM mm
JOIN chan_map AS map ON map.storage_id = mm.storage_id
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
   OR (mm.notified_at IS NOT NULL AND NOT map.projected)
GROUP BY 1, 2, 3, 4, 5;
