ALTER TABLE "external_author_policies" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "external_author_policies" CASCADE;--> statement-breakpoint
DELETE FROM "feature_flags" WHERE "key" IN (
  'external_projection_directory',
  'slack_binding_control_plane',
  'slack_outbound_enqueue',
  'slack_provider_dispatch',
  'slack_custom_authorship',
  'slack_native_mentions',
  'slack_thread_delivery',
  'slack_private_binding',
  'slack_event_ingress',
  'slack_inbound_projection'
);--> statement-breakpoint
ALTER TABLE "external_outbound_deliveries" DROP CONSTRAINT "external_outbound_delivery_contract_valid";--> statement-breakpoint
ALTER TABLE "external_projection_avatar_artifacts" DROP CONSTRAINT "external_avatar_shape_valid";--> statement-breakpoint
DELETE FROM "external_reaction_command_attempts" WHERE "command_id" IN (
  SELECT "id" FROM "external_reaction_commands" WHERE "message_link_id" IN (
    SELECT "id" FROM "external_message_links" WHERE "delivery_id" IS NOT NULL
  )
);--> statement-breakpoint
DELETE FROM "external_reaction_commands" WHERE "message_link_id" IN (
  SELECT "id" FROM "external_message_links" WHERE "delivery_id" IS NOT NULL
);--> statement-breakpoint
DELETE FROM "external_reaction_facts" WHERE "message_link_id" IN (
  SELECT "id" FROM "external_message_links" WHERE "delivery_id" IS NOT NULL
);--> statement-breakpoint
DELETE FROM "external_reaction_states" WHERE "message_link_id" IN (
  SELECT "id" FROM "external_message_links" WHERE "delivery_id" IS NOT NULL
);--> statement-breakpoint
DELETE FROM "external_attachment_transfer_jobs" WHERE "outbound_delivery_id" IS NOT NULL;--> statement-breakpoint
DELETE FROM "external_attachment_message_facts" WHERE "direction" = 'raft_outbound';--> statement-breakpoint
DELETE FROM "external_delivery_attempts";--> statement-breakpoint
DELETE FROM "external_delivery_operator_decisions";--> statement-breakpoint
DELETE FROM "external_message_links" WHERE "delivery_id" IS NOT NULL;--> statement-breakpoint
DELETE FROM "external_outbound_deliveries";--> statement-breakpoint
DELETE FROM "external_delivery_partitions";--> statement-breakpoint
DELETE FROM "external_projection_avatar_artifacts" WHERE "owner_type" IN ('user', 'agent');--> statement-breakpoint
SET CONSTRAINTS ALL IMMEDIATE;--> statement-breakpoint
ALTER TABLE "external_outbound_deliveries" ALTER COLUMN "render_snapshot_schema" SET DEFAULT 'slack-bridge-render-snapshot.v3';--> statement-breakpoint
ALTER TABLE "external_outbound_deliveries" ADD CONSTRAINT "external_outbound_delivery_contract_valid" CHECK ("external_outbound_deliveries"."delivery_contract_version" = 'slack-bridge-delivery.v1'
      AND "external_outbound_deliveries"."render_snapshot_schema" = 'slack-bridge-render-snapshot.v3');--> statement-breakpoint
ALTER TABLE "external_projection_avatar_artifacts" ADD CONSTRAINT "external_avatar_shape_valid" CHECK ("external_projection_avatar_artifacts"."owner_type" = 'external_projection'
      AND length(btrim("external_projection_avatar_artifacts"."owner_id")) > 0
      AND "external_projection_avatar_artifacts"."source_digest" ~ '^[0-9a-f]{64}$'
      AND ("external_projection_avatar_artifacts"."source_locator_digest" IS NULL OR "external_projection_avatar_artifacts"."source_locator_digest" ~ '^[0-9a-f]{64}$')
      AND ("external_projection_avatar_artifacts"."storage_key" IS NULL OR (
        length(btrim("external_projection_avatar_artifacts"."storage_key")) > 0 AND length("external_projection_avatar_artifacts"."storage_key") <= 1024
      ))
      AND (("external_projection_avatar_artifacts"."source_locator_digest" IS NULL AND "external_projection_avatar_artifacts"."storage_key" IS NULL)
        OR ("external_projection_avatar_artifacts"."source_locator_digest" IS NOT NULL AND "external_projection_avatar_artifacts"."storage_key" IS NOT NULL))
      AND "external_projection_avatar_artifacts"."public_url" ~ '^https://'
      AND "external_projection_avatar_artifacts"."mime_type" IN ('image/png', 'image/jpeg', 'image/webp')
      AND "external_projection_avatar_artifacts"."byte_size" > 0 AND "external_projection_avatar_artifacts"."byte_size" <= 5242880
      AND "external_projection_avatar_artifacts"."width" > 0 AND "external_projection_avatar_artifacts"."width" <= 4096
      AND "external_projection_avatar_artifacts"."height" > 0 AND "external_projection_avatar_artifacts"."height" <= 4096
      AND "external_projection_avatar_artifacts"."artifact_revision" > 0
      AND "external_projection_avatar_artifacts"."state" IN ('pending', 'active', 'revoked')
      AND ("external_projection_avatar_artifacts"."state" <> 'pending' OR ("external_projection_avatar_artifacts"."source_locator_digest" IS NOT NULL AND "external_projection_avatar_artifacts"."storage_key" IS NOT NULL)));
