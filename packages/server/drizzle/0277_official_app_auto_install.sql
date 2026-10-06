CREATE TABLE "official_app_auto_install_states" (
	"server_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"state" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "official_app_auto_install_states_server_id_client_id_pk" PRIMARY KEY("server_id","client_id"),
	CONSTRAINT "official_app_auto_install_states_state_valid" CHECK ("official_app_auto_install_states"."state" IN ('default_auto', 'auto_suppressed')),
	CONSTRAINT "official_app_auto_install_states_revision_nonnegative" CHECK ("official_app_auto_install_states"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "official_app_auto_install_transitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"state" text NOT NULL,
	"transition_source" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" uuid,
	"installation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "official_app_auto_install_transitions_state_valid" CHECK ("official_app_auto_install_transitions"."state" IN ('default_auto', 'auto_suppressed')),
	CONSTRAINT "official_app_auto_install_transitions_source_valid" CHECK ("official_app_auto_install_transitions"."transition_source" IN ('auto_install', 'user_install', 'user_uninstall', 'migration')),
	CONSTRAINT "official_app_auto_install_transitions_revision_positive" CHECK ("official_app_auto_install_transitions"."revision" > 0),
	CONSTRAINT "official_app_auto_install_transitions_actor_valid" CHECK (("official_app_auto_install_transitions"."actor_type" = 'human' AND "official_app_auto_install_transitions"."actor_user_id" IS NOT NULL)
      OR ("official_app_auto_install_transitions"."actor_type" = 'system' AND "official_app_auto_install_transitions"."actor_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "official_app_registry" (
	"oauth_client_id" uuid PRIMARY KEY NOT NULL,
	"client_key" text NOT NULL,
	"publisher_server_id" uuid NOT NULL,
	"auto_install" boolean DEFAULT false NOT NULL,
	"purpose" text NOT NULL,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "official_app_registry_client_key_unique" UNIQUE("client_key"),
	CONSTRAINT "official_app_registry_status_valid" CHECK ("official_app_registry"."status" IN ('pending_review', 'approved', 'disabled')),
	CONSTRAINT "official_app_registry_revision_positive" CHECK ("official_app_registry"."revision" > 0),
	CONSTRAINT "official_app_registry_client_key_valid" CHECK ("official_app_registry"."client_key" ~ '^[a-z][a-z0-9-]{2,63}$'),
	CONSTRAINT "official_app_registry_purpose_valid" CHECK (length(btrim("official_app_registry"."purpose")) BETWEEN 1 AND 160 AND "official_app_registry"."purpose" !~ '[\r\n]')
);
--> statement-breakpoint
ALTER TABLE "oauth_client_installs" DROP CONSTRAINT "oauth_client_installs_actor_valid";--> statement-breakpoint
ALTER TABLE "oauth_client_installs" ADD COLUMN "installed_by_system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "official_app_auto_install_states" ADD CONSTRAINT "official_app_auto_install_states_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "official_app_auto_install_states" ADD CONSTRAINT "official_app_auto_install_states_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "official_app_auto_install_transitions" ADD CONSTRAINT "official_app_auto_install_transitions_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "official_app_auto_install_transitions" ADD CONSTRAINT "official_app_auto_install_transitions_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "official_app_auto_install_transitions" ADD CONSTRAINT "official_app_auto_install_transitions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "official_app_auto_install_transitions" ADD CONSTRAINT "official_app_auto_install_transitions_installation_id_oauth_client_installs_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."oauth_client_installs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "official_app_registry" ADD CONSTRAINT "official_app_registry_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "official_app_registry" ADD CONSTRAINT "official_app_registry_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_oauth_clients_registry_identity" ON "oauth_clients" USING btree ("id","client_id","server_id");--> statement-breakpoint
ALTER TABLE "official_app_registry" ADD CONSTRAINT "official_app_registry_client_identity_fk" FOREIGN KEY ("oauth_client_id","client_key","publisher_server_id") REFERENCES "public"."oauth_clients"("id","client_id","server_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "idx_official_app_auto_install_states_client" ON "official_app_auto_install_states" USING btree ("client_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_official_app_auto_install_transitions_revision" ON "official_app_auto_install_transitions" USING btree ("server_id","client_id","revision");--> statement-breakpoint
CREATE INDEX "idx_official_app_auto_install_transitions_latest" ON "official_app_auto_install_transitions" USING btree ("server_id","client_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_official_app_registry_defaults" ON "official_app_registry" USING btree ("status","auto_install");--> statement-breakpoint
ALTER TABLE "oauth_client_installs" ADD CONSTRAINT "oauth_client_installs_actor_valid" CHECK (("oauth_client_installs"."installed_by_user_id" IS NOT NULL AND "oauth_client_installs"."installed_by_agent_id" IS NULL AND "oauth_client_installs"."installed_by_system" = false)
      OR ("oauth_client_installs"."installed_by_user_id" IS NULL AND "oauth_client_installs"."installed_by_agent_id" IS NOT NULL AND "oauth_client_installs"."installed_by_system" = false)
      OR ("oauth_client_installs"."installed_by_user_id" IS NULL AND "oauth_client_installs"."installed_by_agent_id" IS NULL AND "oauth_client_installs"."installed_by_system" = true));--> statement-breakpoint

-- Existing installation rows are known-present. Preserve that fact without
-- guessing whether any absent row represents a historic uninstall. Registry
-- activation performs the fail-closed absent-row reconciliation explicitly.
INSERT INTO "official_app_auto_install_states" ("server_id", "client_id", "state", "revision")
SELECT "server_id", "client_id", 'default_auto', 1
FROM "oauth_client_installs"
ON CONFLICT ("server_id", "client_id") DO NOTHING;--> statement-breakpoint
INSERT INTO "official_app_auto_install_transitions" (
  "id", "server_id", "client_id", "revision", "state", "transition_source", "actor_type", "installation_id"
)
SELECT gen_random_uuid(), i."server_id", i."client_id", 1, 'default_auto', 'migration', 'system', i."id"
FROM "oauth_client_installs" i
ON CONFLICT ("server_id", "client_id", "revision") DO NOTHING;
