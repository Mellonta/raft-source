CREATE TABLE "computer_upgrade_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"target_version" text NOT NULL,
	"requested_by_user_id" uuid,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"outcome" text,
	"observed_version" text,
	"reason" text,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "computer_upgrade_requests" ADD CONSTRAINT "computer_upgrade_requests_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_upgrade_requests" ADD CONSTRAINT "computer_upgrade_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_computer_upgrade_requests_machine_outcome" ON "computer_upgrade_requests" USING btree ("machine_id","outcome");--> statement-breakpoint
CREATE INDEX "idx_computer_upgrade_requests_deadline" ON "computer_upgrade_requests" USING btree ("deadline_at");