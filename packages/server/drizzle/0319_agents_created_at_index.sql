-- RFC-067: the product-data derivation job reads new agents by a created_at
-- watermark every 5 minutes (agents is not CDC'd to RisingWave: the CDC role
-- would need table-wide SELECT, which covers env_vars / runtime_config).
-- created_at is never updated, so this index does not break HOT updates
-- (~78M status updates so far). Staging/prod build it first with
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_created_at ON agents (created_at);
-- so this statement is a no-op there and never holds a write lock on agents.
CREATE INDEX IF NOT EXISTS "idx_agents_created_at" ON "agents" USING btree ("created_at");
