ALTER TABLE "agent_migration_receipt_outbox" DROP CONSTRAINT "agent_migration_receipt_outbox_kind_check";--> statement-breakpoint
ALTER TABLE "agent_migration_receipt_outbox" ADD CONSTRAINT "agent_migration_receipt_outbox_kind_check" CHECK ("agent_migration_receipt_outbox"."receipt_kind" IN ('completed', 'canceled', 'failed', 'aborted'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "validate_agent_migration_receipt_outbox"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM "agent_migrations" migration
		JOIN "agent_migration_receipt_channels" surface
			ON surface."migration_id" = migration."id"
			AND surface."server_id" = migration."server_id"
			AND surface."agent_id" = migration."agent_id"
			AND surface."channel_id" = migration."receipt_channel_id"
		JOIN "messages" message
			ON message."id" = NEW."message_id"
			AND message."channel_id" = surface."channel_id"
		WHERE migration."id" = NEW."migration_id"
			AND (
				(NEW."receipt_kind" = 'completed' AND migration."state" = 'completed')
				OR (NEW."receipt_kind" = 'canceled' AND migration."state" IN ('canceled_pre_flip', 'canceled_post_flip'))
				OR (NEW."receipt_kind" = 'failed' AND migration."state" = 'failed')
				OR (NEW."receipt_kind" = 'aborted' AND migration."state" = 'aborted')
			)
			AND migration."server_id" = NEW."server_id"
			AND migration."agent_id" = NEW."agent_id"
			AND migration."receipt_channel_id" = NEW."channel_id"
			AND surface."server_id" = NEW."server_id"
			AND surface."agent_id" = NEW."agent_id"
			AND surface."channel_id" = NEW."channel_id"
			AND message."sender_type" = 'user'
			AND message."sender_id" = 'system'
			AND message."message_type" = 'system'
	) THEN
		RAISE EXCEPTION 'agent migration receipt outbox identity is invalid';
	END IF;
	RETURN NEW;
END $$;
