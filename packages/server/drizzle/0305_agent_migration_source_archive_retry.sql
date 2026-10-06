ALTER TABLE "agent_migrations" ADD COLUMN "source_workspace_archive_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "source_workspace_archive_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "source_workspace_archive_last_error" text;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "source_workspace_archive_abandoned_at" timestamp with time zone;