DROP TABLE "inbox_serving_rows" CASCADE;--> statement-breakpoint
DELETE FROM "feature_flags" WHERE "key" IN (
  'inbox_serving_derivation_v1',
  'pg_serving_rows_maintenance_v0',
  'inbox_visibility_v3_v0'
);
