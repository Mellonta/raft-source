-- Agent access by connected apps (Agent panel):
-- * oauth_agent_auto_grant_blocks: a person revoked an app's grant for an
--   agent, so that pair no longer gets automatic grants until a person grants
--   again. Starts empty.
-- * oauth_grants.grant_source: how a grant came about (person, the agent's own
--   login, or an app request auto-granted). Nullable, no default: metadata-only
--   on existing rows, which stay null ("not recorded").
-- * third_party_agent_events indexes for the per-agent newest-first list and
--   the 30-days-after-expiry retention sweep. The table only holds connected-app
--   events, so plain CREATE INDEX is fine.
CREATE TABLE "oauth_agent_auto_grant_blocks" (
	"agent_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"blocked_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_agent_auto_grant_blocks_agent_id_client_id_pk" PRIMARY KEY("agent_id","client_id")
);
--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD COLUMN "grant_source" text;--> statement-breakpoint
ALTER TABLE "oauth_agent_auto_grant_blocks" ADD CONSTRAINT "oauth_agent_auto_grant_blocks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_agent_auto_grant_blocks" ADD CONSTRAINT "oauth_agent_auto_grant_blocks_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_agent_auto_grant_blocks" ADD CONSTRAINT "oauth_agent_auto_grant_blocks_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_agent_auto_grant_blocks" ADD CONSTRAINT "oauth_agent_auto_grant_blocks_blocked_by_user_id_users_id_fk" FOREIGN KEY ("blocked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_third_party_agent_events_agent_created" ON "third_party_agent_events" USING btree ("agent_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_third_party_agent_events_expires" ON "third_party_agent_events" USING btree ("expires_at");