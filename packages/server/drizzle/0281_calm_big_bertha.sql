-- Adopt the existing unique index as the UNIQUE constraint in place. The 0277
-- composite FK depends on this index, so it cannot be dropped and recreated.
ALTER TABLE "oauth_clients" ADD CONSTRAINT "idx_oauth_clients_registry_identity" UNIQUE USING INDEX "idx_oauth_clients_registry_identity";