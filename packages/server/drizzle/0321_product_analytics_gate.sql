-- RFC-067 product analytics: the random analytics-id mapping and the three
-- user/workspace controls, all read through services/productAnalyticsGate.ts.
-- New nullable columns and a constant default are metadata-only. The mapping
-- table is the only part replicated to RisingWave (user_id, analytics_id).
CREATE TABLE "user_analytics_ids" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"analytics_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_analytics_ids_analytics_id_unique" UNIQUE("analytics_id")
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "product_analytics_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "analytics_opted_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "share_usage_data" boolean;--> statement-breakpoint
ALTER TABLE "user_analytics_ids" ADD CONSTRAINT "user_analytics_ids_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- RFC-067 §3.4: every user gets a random analytics id at insert, whatever the
-- signup path. Opt-out deletes the row (productAnalyticsGate.ts); this trigger
-- only fires on users INSERT, so it never re-creates an opted-out mapping.
CREATE OR REPLACE FUNCTION "users_create_analytics_id"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO "user_analytics_ids" ("user_id", "analytics_id")
  VALUES (NEW."id", gen_random_uuid())
  ON CONFLICT ("user_id") DO NOTHING;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "users_create_analytics_id"
AFTER INSERT ON "users"
FOR EACH ROW
EXECUTE FUNCTION "users_create_analytics_id"();--> statement-breakpoint
-- Existing users (about 31k in prod). Runs after the trigger exists, so a user
-- inserted concurrently is covered by one or the other.
INSERT INTO "user_analytics_ids" ("user_id", "analytics_id")
SELECT "id", gen_random_uuid()
FROM "users"
ON CONFLICT ("user_id") DO NOTHING;
