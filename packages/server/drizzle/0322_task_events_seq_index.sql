-- RFC-067: the product-data derivation job reads task_events by a seq
-- watermark (bounded by created_at < now() - 2 minutes for commit order).
-- task_events is append-only (~11k rows/day). Staging/prod build it first with
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_task_events_seq ON task_events (seq);
-- so this statement is a no-op there and never holds a write lock.
CREATE INDEX IF NOT EXISTS "idx_task_events_seq" ON "task_events" USING btree ("seq");
