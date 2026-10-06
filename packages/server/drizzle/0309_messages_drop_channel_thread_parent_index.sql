-- Intentionally managed outside the transactional Drizzle migration, like 0293
-- (which built it). #8563 moved channel-filtered search to
-- channels.parent_channel_id, so nothing reads idx_messages_channel_thread_parent
-- anymore. Production drops it with DROP INDEX CONCURRENTLY
-- (db:drop-messages-thread-parent-index) and checks it is gone
-- (db:verify-messages-thread-parent-index-dropped); a plain DROP INDEX would take
-- an ACCESS EXCLUSIVE lock on messages. This migration only advances the schema
-- snapshot. Everything stays correct while the index still exists.
SELECT 1;
