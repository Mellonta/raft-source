-- channels.parent_channel_id: for a thread, the channel its parent message
-- currently lives in; NULL for non-threads and threads without a parent
-- message (joint projections). Derived data owned by these triggers only:
-- every thread write site and every parent-message move (channel conversion
-- and its rollback) is covered in the writer's own transaction, including
-- older app revisions still serving during a rolling deploy. Existing rows are
-- backfilled separately in batches; readers switch only after the alert-only
-- invariant (parent_channel_id = parent message's channel_id) reads 0.
ALTER TABLE "channels" ADD COLUMN "parent_channel_id" uuid;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "channels_derive_parent_channel_id"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."type" = 'thread' AND NEW."parent_message_id" IS NOT NULL THEN
    NEW."parent_channel_id" := (
      SELECT parent_message."channel_id"
      FROM "messages" parent_message
      WHERE parent_message."id" = NEW."parent_message_id"
    );
  ELSE
    NEW."parent_channel_id" := NULL;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "channels_parent_channel_id_insert"
BEFORE INSERT ON "channels"
FOR EACH ROW
EXECUTE FUNCTION "channels_derive_parent_channel_id"();--> statement-breakpoint
-- Also fires when anything writes parent_channel_id directly, so the column
-- can only ever hold the derived value (the backfill relies on this).
CREATE TRIGGER "channels_parent_channel_id_update"
BEFORE UPDATE OF "parent_message_id", "type", "parent_channel_id" ON "channels"
FOR EACH ROW
WHEN (
  OLD."parent_message_id" IS DISTINCT FROM NEW."parent_message_id"
  OR OLD."type" IS DISTINCT FROM NEW."type"
  OR OLD."parent_channel_id" IS DISTINCT FROM NEW."parent_channel_id"
)
EXECUTE FUNCTION "channels_derive_parent_channel_id"();--> statement-breakpoint
-- A parent message moving channel (conversion, rollback) re-derives its
-- threads. Updating the non-key parent_channel_id takes FOR NO KEY UPDATE on
-- the thread row, which does not conflict with readers' FOR KEY SHARE, so this
-- message -> thread order cannot close a cycle with the thread -> parent
-- message resolution order (pinned by channelParentChannelIdTrigger.realPg.test.ts).
CREATE OR REPLACE FUNCTION "messages_follow_parent_channel_id"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "channels"
  SET "parent_channel_id" = NEW."channel_id"
  WHERE "parent_message_id" = NEW."id"
    AND "type" = 'thread'
    AND "parent_channel_id" IS DISTINCT FROM NEW."channel_id";
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "messages_parent_channel_id_follow"
AFTER UPDATE OF "channel_id" ON "messages"
FOR EACH ROW
WHEN (OLD."channel_id" IS DISTINCT FROM NEW."channel_id")
EXECUTE FUNCTION "messages_follow_parent_channel_id"();
