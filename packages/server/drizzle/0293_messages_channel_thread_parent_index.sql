-- Intentionally managed outside the transactional Drizzle migration, like 0236
-- and 0248. Production must build idx_messages_channel_thread_parent with
-- CREATE INDEX CONCURRENTLY (db:create-messages-thread-parent-index) and verify
-- it is valid/ready (db:verify-messages-thread-parent-index); this migration
-- only advances the schema snapshot. Search stays correct without the index;
-- it is what makes "threads whose parent is in channel X" an index-only scan.
SELECT 1;
