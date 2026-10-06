CREATE TABLE "agent_runtime_provider_configs" (
	"server_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"base_url" text NOT NULL,
	"encrypted_token" text NOT NULL,
	"config_revision" integer DEFAULT 1 NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runtime_provider_configs_server_id_provider_pk" PRIMARY KEY("server_id","provider")
);
--> statement-breakpoint
CREATE TABLE "agent_runtime_provisions" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"state" text NOT NULL,
	"provider_agent_id" text,
	"credential_id" uuid,
	"encrypted_credential" text,
	"provisioned_name" text NOT NULL,
	"provisioned_instructions" text NOT NULL,
	"desired_revision" integer DEFAULT 0 NOT NULL,
	"synced_revision" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"lease_generation" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"last_error_message" text,
	"last_error_http_status" integer,
	"last_error_at" timestamp with time zone,
	"push_registered" boolean,
	"push_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_runtime_provider_configs" ADD CONSTRAINT "agent_runtime_provider_configs_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_provider_configs" ADD CONSTRAINT "agent_runtime_provider_configs_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_provisions" ADD CONSTRAINT "agent_runtime_provisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_provisions" ADD CONSTRAINT "agent_runtime_provisions_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_provisions" ADD CONSTRAINT "agent_runtime_provisions_credential_id_agent_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."agent_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_runtime_provisions_server" ON "agent_runtime_provisions" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_agent_runtime_provisions_due" ON "agent_runtime_provisions" USING btree ("next_attempt_at") WHERE state IN ('provisioning', 'deleting') OR (state = 'active' AND desired_revision > synced_revision);