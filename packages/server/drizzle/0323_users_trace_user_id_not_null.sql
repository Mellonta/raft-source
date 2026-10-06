-- users.trace_user_id becomes NOT NULL. Production and staging were backfilled
-- with db:backfill-users-trace-user-id (2026-10-05: 0 NULL rows left), so the
-- UPDATE below changes nothing there; it only fills environments that never
-- ran the backfill, so the constraint can't fail on them. users is small
-- (~31k rows, 31MB): the SET NOT NULL scan holds its lock for milliseconds.
-- Bounded lock wait: SET NOT NULL needs ACCESS EXCLUSIVE on users, which every
-- authenticated request reads. If a long transaction holds users, give up after
-- 5s (the deploy retries) instead of queueing every request behind this ALTER.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
UPDATE "users" SET "trace_user_id" = gen_random_uuid() WHERE "trace_user_id" IS NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "trace_user_id" SET NOT NULL;
