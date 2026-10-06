ALTER TABLE "external_channel_bindings" DROP CONSTRAINT "external_channel_binding_privacy_valid";--> statement-breakpoint
-- Existing bindings have never been verified against Slack. Backfill them at
-- the migration instant so the strict `fresh_until > now` admission check
-- treats them as stale, while bindings created after this migration retain the
-- ordinary ten-minute freshness established from their provisioning receipt.
ALTER TABLE "external_channel_bindings" ADD COLUMN "privacy_fresh_until" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "external_channel_bindings" ALTER COLUMN "privacy_fresh_until" SET DEFAULT now() + interval '10 minutes';--> statement-breakpoint
ALTER TABLE "external_channel_bindings" ADD CONSTRAINT "external_channel_binding_privacy_valid" CHECK (("external_channel_bindings"."privacy_class" = 'public' AND "external_channel_bindings"."provider_conversation_kind" = 'public_channel'
      AND "external_channel_bindings"."audience_revision" IS NULL AND "external_channel_bindings"."audience_fresh_until" IS NULL)
      OR ("external_channel_bindings"."privacy_class" = 'private' AND "external_channel_bindings"."provider_conversation_kind" = 'private_channel'
      AND (("external_channel_bindings"."audience_revision" IS NOT NULL AND "external_channel_bindings"."audience_revision" > 0
        AND "external_channel_bindings"."audience_fresh_until" IS NOT NULL)
        OR ("external_channel_bindings"."state" = 'paused' AND "external_channel_bindings"."state_reason" = 'privacy_changed_audience_migration_required'
          AND "external_channel_bindings"."audience_revision" IS NULL AND "external_channel_bindings"."audience_fresh_until" IS NULL))));
