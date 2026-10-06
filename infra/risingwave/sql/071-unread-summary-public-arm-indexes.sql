-- Indexes for the public arm of GET /api/channels/unread?summary=1
-- (readConversationUnreadSummaryRows in channelService.ts): the server's live
-- public channels the user has not joined, whose latest seq is past the user's
-- cursor.
--
-- Without these indexes the public arm was slow even for a small result, and
-- `count(*) FROM rw_channels WHERE server_id = ...` alone was slow for a server
-- with few public channels. None of the three relations below had an index, so
-- rw_channels was a full BatchScan (a large table, mostly threads), and
-- rw_target_eligible_v1 and rw_channel_humans were full scans feeding hash joins.
--
-- 1. rw_channels by server: turns the full scan into a range scan of one
--    server's channels. Some deployments already had this index (created
--    outside the repo, before this file); clusters that lacked it were the slow
--    ones. Recorded here verbatim so the repo and every cluster match. No
--    INCLUDE: RisingWave carries every other column, distributed by server_id.
--    Do NOT re-run where the index already exists.
CREATE INDEX idx_rw_channels_server_active_type
  ON rw_channels (server_id, deleted_at, archived_at, type);

-- 2. rw_channel_humans by user: the arm's anti-join (ch.user_id IS NULL) is
--    against one user's memberships.
CREATE INDEX idx_rw_channel_humans_user
  ON rw_channel_humans (user_id, channel_id);

-- 3. rw_target_eligible_v1 by target: a lookup join per channel instead of a
--    full scan + hash join. The view has the one column.
CREATE INDEX idx_rw_target_eligible_v1_target
  ON rw_target_eligible_v1 (target_id);
