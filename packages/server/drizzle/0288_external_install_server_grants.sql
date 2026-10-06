CREATE TABLE "external_app_install_server_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"install_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"registration_id" uuid NOT NULL,
	"server_grant_id" uuid NOT NULL,
	"grant_epoch" integer NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"authorized_by_type" text NOT NULL,
	"authorized_by_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_app_install_server_grant_epoch_positive" CHECK ("external_app_install_server_grants"."grant_epoch" > 0),
	CONSTRAINT "external_app_install_server_grant_state_valid" CHECK ("external_app_install_server_grants"."state" IN ('active', 'revoked')),
	CONSTRAINT "external_app_install_server_grant_actor_type_valid" CHECK ("external_app_install_server_grants"."authorized_by_type" IN ('human', 'agent')),
	CONSTRAINT "external_app_install_server_grant_revocation_valid" CHECK (("external_app_install_server_grants"."state" = 'active' AND "external_app_install_server_grants"."revoked_at" IS NULL AND "external_app_install_server_grants"."revoke_reason" IS NULL)
      OR ("external_app_install_server_grants"."state" = 'revoked' AND "external_app_install_server_grants"."revoked_at" IS NOT NULL AND length(btrim("external_app_install_server_grants"."revoke_reason")) > 0))
);
--> statement-breakpoint
ALTER TABLE "external_app_installs" DROP CONSTRAINT "external_app_installs_server_id_servers_id_fk";
--> statement-breakpoint
ALTER TABLE "external_app_install_server_grants" ADD CONSTRAINT "external_app_install_server_grants_install_id_external_app_installs_id_fk" FOREIGN KEY ("install_id") REFERENCES "public"."external_app_installs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_app_install_server_grants" ADD CONSTRAINT "external_app_install_server_grants_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_app_install_server_grants" ADD CONSTRAINT "external_app_install_server_grants_registration_id_external_app_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."external_app_registrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_app_install_server_grants" ADD CONSTRAINT "external_app_install_server_grants_server_grant_id_external_app_server_grants_id_fk" FOREIGN KEY ("server_grant_id") REFERENCES "public"."external_app_server_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_app_install_server_grant_scope" ON "external_app_install_server_grants" USING btree ("install_id","server_id");--> statement-breakpoint
CREATE INDEX "idx_external_app_install_server_grant_server_state" ON "external_app_install_server_grants" USING btree ("server_id","registration_id","state");--> statement-breakpoint
CREATE INDEX "idx_external_app_install_server_grant_authority" ON "external_app_install_server_grants" USING btree ("server_grant_id","grant_epoch");--> statement-breakpoint
ALTER TABLE "external_app_installs" ADD CONSTRAINT "external_app_installs_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "external_app_install_server_grants" (
	"id", "install_id", "server_id", "registration_id", "server_grant_id",
	"grant_epoch", "state", "authorized_by_type", "authorized_by_id", "created_at", "updated_at"
)
SELECT gen_random_uuid(), install.id, install.server_id, install.registration_id,
	install.server_grant_id, install.grant_epoch, 'active', asg.granted_by_type, asg.granted_by_id,
	install.created_at, install.updated_at
FROM "external_app_installs" install
JOIN "external_app_server_grants" asg
	ON asg.id = install.server_grant_id
WHERE install.state <> 'revoked'
ON CONFLICT ("install_id", "server_id") DO NOTHING;
