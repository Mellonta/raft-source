-- messages.server_id: the channel's server on every message, so the text-match
-- step of a search can later read one server's matches through a
-- (server_id, search_vector) GIN instead of every server's. Metadata-only here:
-- a nullable column with no default, two triggers and a NOT VALID check. Older
-- rows are filled by the operator backfill (db:backfill-messages-server-id);
-- VALIDATE, SET NOT NULL and the GIN come in later steps. channels.server_id is
-- immutable (0310), so a stored server_id cannot go stale. Joint messages carry
-- the joint_storage server that owns their canonical channel. Not in
-- slock_rw_publication's column list.
ALTER TABLE "messages" ADD COLUMN "server_id" uuid;--> statement-breakpoint
-- Insert (hot path): one primary-key read of the channel. Always derived, so no
-- writer can store a server that disagrees with the channel.
CREATE OR REPLACE FUNCTION "messages_set_server_id"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  SELECT c."server_id" INTO NEW."server_id"
  FROM "channels" c
  WHERE c."id" = NEW."channel_id";
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "messages_server_id_insert"
BEFORE INSERT ON "messages"
FOR EACH ROW
EXECUTE FUNCTION "messages_set_server_id"();--> statement-breakpoint
-- Update: a channel move re-derives it, and any other update of a row the
-- backfill has not reached yet fills it. The second case matters because a
-- non-HOT update can move an unfilled row into a page the backfill has already
-- passed. The backfill's own UPDATE sets server_id, so it does not fire this.
CREATE TRIGGER "messages_server_id_update"
BEFORE UPDATE ON "messages"
FOR EACH ROW
WHEN (OLD."channel_id" IS DISTINCT FROM NEW."channel_id" OR NEW."server_id" IS NULL)
EXECUTE FUNCTION "messages_set_server_id"();--> statement-breakpoint
-- Migration receipt messages stay immutable, with one exception: the backfill
-- filling server_id from NULL with the channel's server while every other
-- column is unchanged. The exemption sits inside the receipt branch, so other
-- messages pay nothing extra. search_vector is compared through search_text
-- (its only input): a BEFORE trigger does not see generated values. Rows are
-- compared as text because action_metadata is json, which has no equality.
CREATE OR REPLACE FUNCTION "reject_agent_migration_receipt_message_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	filled "messages";
BEGIN
	IF EXISTS (SELECT 1 FROM "agent_migration_receipt_outbox" WHERE "message_id" = OLD."id") THEN
		IF TG_OP = 'UPDATE' AND OLD."server_id" IS NULL AND NEW."server_id" IS NOT NULL THEN
			filled := NEW;
			filled."server_id" := NULL;
			filled."search_vector" := OLD."search_vector";
			IF filled::text = OLD::text
				AND NEW."server_id" = (SELECT c."server_id" FROM "channels" c WHERE c."id" = OLD."channel_id") THEN
				RETURN NEW;
			END IF;
		END IF;
		RAISE EXCEPTION 'agent migration receipt message is immutable';
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
-- New rows are held to NOT NULL now; existing rows are checked by VALIDATE after
-- the backfill, which lets SET NOT NULL skip its full-table scan.
ALTER TABLE "messages" ADD CONSTRAINT "messages_server_id_not_null" CHECK ("server_id" IS NOT NULL) NOT VALID;
