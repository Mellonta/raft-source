-- users.trace_user_id: the random id traces carry instead of the user id.
-- Two statements on purpose: ADD COLUMN with a volatile default
-- (gen_random_uuid()) would rewrite the whole table under an exclusive lock,
-- and every authenticated request reads users. Adding the column bare and then
-- setting the default only changes the catalog; new rows get a value from the
-- default, existing rows are filled in batches by
-- db:backfill-users-trace-user-id, and NOT NULL comes in a later migration.
ALTER TABLE "users" ADD COLUMN "trace_user_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "trace_user_id" SET DEFAULT gen_random_uuid();
