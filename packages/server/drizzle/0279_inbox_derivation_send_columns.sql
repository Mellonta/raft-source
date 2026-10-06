ALTER TABLE "messages" ADD COLUMN "causal_actor_type" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "causal_actor_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "system_subtype" text;