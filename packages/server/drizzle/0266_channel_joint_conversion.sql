CREATE TABLE "channel_conversion_fences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"source_channel_id" uuid NOT NULL,
	"conversion_epoch" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"reason" text,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_conversion_phase_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"conversion_epoch" uuid NOT NULL,
	"phase" text NOT NULL,
	"batch_key" text DEFAULT 'all' NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"source_count" integer DEFAULT 0 NOT NULL,
	"target_count" integer DEFAULT 0 NOT NULL,
	"checksum" text NOT NULL,
	"error" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_cards" ADD COLUMN "conversion_job_id" uuid;--> statement-breakpoint
ALTER TABLE "action_cards" ADD COLUMN "conversion_source_channel_id" uuid;--> statement-breakpoint
ALTER TABLE "action_cards" ADD COLUMN "conversion_epoch" uuid;--> statement-breakpoint
ALTER TABLE "action_cards" ADD COLUMN "freeze_state" text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "action_cards" ADD COLUMN "confirmation_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "action_cards" ADD COLUMN "reconfirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "action_cards" ADD COLUMN "reconfirmed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "channel_conversion_jobs" ADD COLUMN "state" text DEFAULT 'prepared' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_conversion_jobs" ADD COLUMN "conversion_epoch" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_conversion_fences" ADD CONSTRAINT "channel_conversion_fences_job_id_channel_conversion_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."channel_conversion_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_conversion_fences" ADD CONSTRAINT "channel_conversion_fences_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_conversion_fences" ADD CONSTRAINT "channel_conversion_fences_source_channel_id_channels_id_fk" FOREIGN KEY ("source_channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_conversion_phase_ledger" ADD CONSTRAINT "channel_conversion_phase_ledger_job_id_channel_conversion_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."channel_conversion_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_channel_conversion_fences_job_epoch" ON "channel_conversion_fences" USING btree ("job_id","conversion_epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_channel_conversion_fences_active_source" ON "channel_conversion_fences" USING btree ("source_channel_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "idx_channel_conversion_fences_epoch" ON "channel_conversion_fences" USING btree ("conversion_epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_channel_conversion_phase_ledger_idempotency" ON "channel_conversion_phase_ledger" USING btree ("job_id","conversion_epoch","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_channel_conversion_phase_ledger_job_phase" ON "channel_conversion_phase_ledger" USING btree ("job_id","phase");--> statement-breakpoint
ALTER TABLE "action_cards" ADD CONSTRAINT "action_cards_conversion_job_id_channel_conversion_jobs_id_fk" FOREIGN KEY ("conversion_job_id") REFERENCES "public"."channel_conversion_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_cards" ADD CONSTRAINT "action_cards_conversion_source_channel_id_channels_id_fk" FOREIGN KEY ("conversion_source_channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_cards" ADD CONSTRAINT "action_cards_reconfirmed_by_user_id_users_id_fk" FOREIGN KEY ("reconfirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_action_cards_conversion_job" ON "action_cards" USING btree ("conversion_job_id","freeze_state");--> statement-breakpoint
CREATE INDEX "idx_channel_conversion_jobs_epoch" ON "channel_conversion_jobs" USING btree ("conversion_epoch");--> statement-breakpoint
ALTER TABLE "action_cards" ADD CONSTRAINT "action_cards_freeze_state_check" CHECK ("action_cards"."freeze_state" IN ('ready', 'frozen', 'reconfirm_required'));
--> statement-breakpoint
WITH active_jobs AS (
  UPDATE "channel_conversion_jobs"
     SET "conversion_epoch" = COALESCE("conversion_epoch", gen_random_uuid()),
         "state" = CASE
           WHEN "status" = 'failed' THEN 'retry_waiting'
           WHEN "phase" = 'prepare' THEN 'fenced'
           ELSE 'copying'
         END
   WHERE "status" IN ('pending', 'running', 'failed')
   RETURNING "id", "server_id", "source_channel_id", "conversion_epoch"
)
INSERT INTO "channel_conversion_fences" (
  "id", "job_id", "server_id", "source_channel_id", "conversion_epoch", "status", "acquired_at", "created_at", "updated_at"
)
SELECT gen_random_uuid(), job."id", job."server_id", job."source_channel_id", job."conversion_epoch", 'active', now(), now(), now()
  FROM active_jobs job;
--> statement-breakpoint
INSERT INTO "feature_flags" (
  "key",
  "description",
  "enabled",
  "kill_switch",
  "randomization_unit",
  "default_enabled",
  "default_variant",
  "salt"
) VALUES (
  'channel_to_joint_conversion_v0',
  'Ordinary/private Channel to Joint conversion entry and API gate',
  true,
  false,
  'server',
  false,
  NULL,
  'channel_to_joint_conversion_v0'
) ON CONFLICT ("key") DO NOTHING;

--> statement-breakpoint
-- Migrate the historical runner receipt; copied jobs retain their epoch/fence
-- and repair forward through verification and audience cutover.
UPDATE "channel_conversion_jobs"
SET "phase" = CASE
  WHEN "phase" = 'drop_task_identity' THEN 'prepare_tasks'
  WHEN "phase" = 'finalize' AND "status" IN ('pending','running','failed') THEN 'verify'
  ELSE "phase" END,
  "state" = CASE WHEN "status" = 'done' THEN 'succeeded' WHEN "status" = 'canceled' THEN 'canceled' ELSE "state" END,
  "progress" = CASE WHEN "canonical_channel_id" IS NOT NULL
    THEN "progress" || '{"canonicalCopyStarted":true}'::jsonb ELSE "progress" END;
--> statement-breakpoint

-- Squashed from the former 0267_channel_conversion_admission migration.
CREATE TABLE "channel_conversion_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"source_channel_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"job_id" uuid,
	"error" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_conversion_commands" ADD CONSTRAINT "channel_conversion_commands_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_conversion_commands" ADD CONSTRAINT "channel_conversion_commands_source_channel_id_channels_id_fk" FOREIGN KEY ("source_channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_conversion_commands" ADD CONSTRAINT "channel_conversion_commands_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_conversion_commands" ADD CONSTRAINT "channel_conversion_commands_job_id_channel_conversion_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."channel_conversion_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_channel_conversion_commands_source" ON "channel_conversion_commands" USING btree ("server_id","source_channel_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_channel_conversion_commands_pending" ON "channel_conversion_commands" USING btree ("status","created_at");--> statement-breakpoint
