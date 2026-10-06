CREATE TABLE "durable_tasks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text NOT NULL,
	"attempts" integer NOT NULL,
	"max_attempts" integer NOT NULL,
	"claimed_by" text,
	"lease_until" timestamp with time zone NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "durable_tasks_state_check" CHECK ("durable_tasks"."state" IN ('open', 'succeeded', 'needs_attention')),
	CONSTRAINT "durable_tasks_attempts_check" CHECK ("durable_tasks"."attempts" >= 1 AND "durable_tasks"."max_attempts" >= 1)
);
--> statement-breakpoint
CREATE INDEX "idx_durable_tasks_open_lease_until" ON "durable_tasks" USING btree ("lease_until") WHERE "durable_tasks"."state" = 'open';--> statement-breakpoint
CREATE INDEX "idx_durable_tasks_succeeded_finished_at" ON "durable_tasks" USING btree ("finished_at") WHERE "durable_tasks"."state" = 'succeeded';--> statement-breakpoint
-- Every task is updated several times (claim, heartbeats, finish), so vacuum at
-- ~2% change like `messages` (0291). Not part of the RisingWave publication
-- (explicit table list).
ALTER TABLE "durable_tasks" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
