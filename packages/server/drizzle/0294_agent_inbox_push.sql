CREATE TABLE "agent_inbox_events_pending_acks" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"seqs" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_inbox_push_registrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"endpoint_url" text NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_iv" text NOT NULL,
	"secret_auth_tag" text NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requested_at" timestamp with time zone,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"consecutive_rejections" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_delivery_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_inbox_push_registrations_failures_nonnegative" CHECK ("agent_inbox_push_registrations"."consecutive_failures" >= 0 AND "agent_inbox_push_registrations"."consecutive_rejections" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_inbox_events_pending_acks" ADD CONSTRAINT "agent_inbox_events_pending_acks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_inbox_push_registrations" ADD CONSTRAINT "agent_inbox_push_registrations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_inbox_push_registrations" ADD CONSTRAINT "agent_inbox_push_registrations_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_inbox_push_registrations" ADD CONSTRAINT "agent_inbox_push_registrations_credential_id_agent_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."agent_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_inbox_push_registrations_agent" ON "agent_inbox_push_registrations" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_inbox_push_registrations_due" ON "agent_inbox_push_registrations" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_agent_inbox_push_registrations_credential" ON "agent_inbox_push_registrations" USING btree ("credential_id");