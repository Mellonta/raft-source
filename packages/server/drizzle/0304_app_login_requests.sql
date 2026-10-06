CREATE TABLE "app_login_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code_challenge" text NOT NULL,
	"return_uri" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"user_id" uuid,
	"code_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_login_requests_status_check" CHECK ("app_login_requests"."status" IN ('pending', 'approved', 'denied', 'completed'))
);
--> statement-breakpoint
ALTER TABLE "app_login_requests" ADD CONSTRAINT "app_login_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_app_login_requests_code_hash" ON "app_login_requests" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "idx_app_login_requests_expires_at" ON "app_login_requests" USING btree ("expires_at");