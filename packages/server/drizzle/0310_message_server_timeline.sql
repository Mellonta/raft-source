-- message_server_timeline: one row per message (server_id, created_at,
-- message_id, channel_id), so a newest-first search can read one server's
-- messages instead of walking every server's. Derived data owned by these
-- triggers only; existing messages are backfilled separately in batches
-- (INSERT ... ON CONFLICT DO NOTHING, since the trigger writes new rows from
-- the moment this migration commits). Not in slock_rw_publication.
CREATE TABLE "message_server_timeline" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"channel_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_server_timeline" ADD CONSTRAINT "message_server_timeline_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_message_server_timeline_server_created" ON "message_server_timeline" USING btree ("server_id","created_at","message_id");--> statement-breakpoint
-- Message insert (hot path): one primary-key read of the channel and one
-- insert. It never fails an insert that would otherwise succeed: the channel
-- exists (messages.channel_id is a foreign key), and a row that is already
-- there (the backfill racing a new message) is left alone.
CREATE OR REPLACE FUNCTION "message_server_timeline_on_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO "message_server_timeline" ("message_id", "server_id", "created_at", "channel_id")
  SELECT NEW."id", c."server_id", NEW."created_at", NEW."channel_id"
  FROM "channels" c
  WHERE c."id" = NEW."channel_id"
  ON CONFLICT ("message_id") DO NOTHING;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "messages_server_timeline_insert"
AFTER INSERT ON "messages"
FOR EACH ROW
EXECUTE FUNCTION "message_server_timeline_on_insert"();--> statement-breakpoint
-- A message moving channel (conversion and its rollback) or, defensively, a
-- created_at rewrite (no writer does either to created_at today) re-derives
-- its row. Upsert, so a message the backfill has not reached yet gets its row
-- now instead of a stale one later.
CREATE OR REPLACE FUNCTION "message_server_timeline_on_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO "message_server_timeline" ("message_id", "server_id", "created_at", "channel_id")
  SELECT NEW."id", c."server_id", NEW."created_at", NEW."channel_id"
  FROM "channels" c
  WHERE c."id" = NEW."channel_id"
  ON CONFLICT ("message_id") DO UPDATE
  SET "server_id" = EXCLUDED."server_id",
      "created_at" = EXCLUDED."created_at",
      "channel_id" = EXCLUDED."channel_id";
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "messages_server_timeline_update"
AFTER UPDATE OF "channel_id", "created_at" ON "messages"
FOR EACH ROW
WHEN (
  OLD."channel_id" IS DISTINCT FROM NEW."channel_id"
  OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
)
EXECUTE FUNCTION "message_server_timeline_on_update"();--> statement-breakpoint
-- The timeline copies channels.server_id per message. No writer moves a
-- channel between servers (only the one-off 0102 conversion ever did), so
-- forbid it instead of re-deriving every message of the channel: a future
-- need must come with its own timeline handling.
CREATE OR REPLACE FUNCTION "channels_forbid_server_id_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'channels.server_id is immutable (channel %): message_server_timeline copies it per message', OLD."id"
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "channels_server_id_immutable"
BEFORE UPDATE OF "server_id" ON "channels"
FOR EACH ROW
WHEN (OLD."server_id" IS DISTINCT FROM NEW."server_id")
EXECUTE FUNCTION "channels_forbid_server_id_change"();