-- Intentionally managed outside the transactional Drizzle migration, like 0236,
-- 0248 and 0293. Production must build idx_channels_thread_parent_channel with
-- CREATE INDEX CONCURRENTLY (db:create-channels-thread-parent-channel-index) and
-- verify it is valid/ready (db:verify-channels-thread-parent-channel-index);
-- this migration only advances the schema snapshot. Nothing reads it until
-- search switches its thread arms to channels.parent_channel_id.
SELECT 1;
