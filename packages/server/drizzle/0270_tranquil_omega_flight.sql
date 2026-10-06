CREATE TABLE "provider_probe_intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"config_version" integer NOT NULL,
	"credential_version" integer NOT NULL,
	"computer_id" uuid NOT NULL,
	"runtime" text NOT NULL,
	"model" text NOT NULL,
	"probe_kind" text NOT NULL,
	"probe_request_id" text NOT NULL,
	"request_digest" text NOT NULL,
	"intent_digest" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"dispatched_at" timestamp with time zone,
	"close_reason" text,
	"closed_at" timestamp with time zone,
	"dispatch_request_id" text,
	"dispatch_epoch_id" text,
	"dispatch_generation" text,
	"capability_observed" boolean,
	"dispatch_daemon_version" text,
	"dispatch_computer_version" text,
	"dispatch_runtime_version" text,
	"dispatch_runtimes" jsonb,
	"claim_machine_id" uuid,
	"claim_request_id" text,
	"claim_epoch_id" text,
	"claim_generation" text,
	"claim_leased_at" timestamp with time zone,
	"materialization_digest" text,
	CONSTRAINT "provider_probe_intents_kind_known" CHECK ("provider_probe_intents"."probe_kind" in ('canary')),
	CONSTRAINT "provider_probe_intents_close_reason_known" CHECK ("provider_probe_intents"."close_reason" is null or "provider_probe_intents"."close_reason" in ('receipt', 'carrier_offline', 'carrier_timeout', 'unsupported_carrier', 'provider_timeout', 'stale_authority', 'intent_expired', 'invalid_carrier_result'))
);
--> statement-breakpoint
CREATE TABLE "provider_probe_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"probe_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"category" text,
	"latency_ms" integer,
	"response_sha256" text,
	"response_bytes" integer,
	"result_digest" text NOT NULL,
	"intent_digest" text NOT NULL,
	"materialization_digest" text,
	"authority_identity" text,
	"daemon_version" text,
	"computer_version" text,
	"runtime_version" text,
	"dispatch_epoch_id" text,
	"dispatch_generation" text,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_probe_receipts_probe_id_unique" UNIQUE("probe_id"),
	CONSTRAINT "provider_probe_receipts_outcome_known" CHECK ("provider_probe_receipts"."outcome" in ('success', 'failure')),
	CONSTRAINT "provider_probe_receipts_category_known" CHECK ("provider_probe_receipts"."category" is null or "provider_probe_receipts"."category" in ('auth', 'model', 'network', 'dns_tls', 'rate_quota', 'invalid_response', 'carrier_offline', 'carrier_timeout', 'unsupported_carrier', 'provider_timeout', 'stale_authority', 'intent_expired', 'invalid_carrier_result')),
	CONSTRAINT "provider_probe_receipts_bytes_nonneg" CHECK ("provider_probe_receipts"."response_bytes" is null or "provider_probe_receipts"."response_bytes" >= 0),
	CONSTRAINT "provider_probe_receipts_success_needs_response" CHECK ("provider_probe_receipts"."outcome" <> 'success' or ("provider_probe_receipts"."response_sha256" is not null and "provider_probe_receipts"."response_bytes" is not null and "provider_probe_receipts"."authority_identity" is not null))
);
--> statement-breakpoint
ALTER TABLE "provider_probe_intents" ADD CONSTRAINT "provider_probe_intents_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_probe_intents" ADD CONSTRAINT "provider_probe_intents_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_probe_intents" ADD CONSTRAINT "provider_probe_intents_computer_id_daemons_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."daemons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_probe_intents" ADD CONSTRAINT "provider_probe_intents_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_probe_intents" ADD CONSTRAINT "provider_probe_intents_claim_machine_id_daemons_id_fk" FOREIGN KEY ("claim_machine_id") REFERENCES "public"."daemons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_probe_receipts" ADD CONSTRAINT "provider_probe_receipts_probe_id_provider_probe_intents_id_fk" FOREIGN KEY ("probe_id") REFERENCES "public"."provider_probe_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_probe_receipts" ADD CONSTRAINT "provider_probe_receipts_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_provider_probe_intents_server_request" ON "provider_probe_intents" USING btree ("server_id","probe_request_id");--> statement-breakpoint
CREATE INDEX "idx_provider_probe_intents_server_connection" ON "provider_probe_intents" USING btree ("server_id","connection_id");--> statement-breakpoint
CREATE INDEX "idx_provider_probe_intents_authority_match" ON "provider_probe_intents" USING btree ("server_id","connection_id","config_version","credential_version","computer_id","runtime","model","probe_kind");--> statement-breakpoint
INSERT INTO "feature_flags" (
	"key",
	"description",
	"enabled",
	"kill_switch",
	"randomization_unit",
	"default_enabled",
	"default_variant",
	"salt"
) VALUES (
	'provider_computer_probe_v0',
	'Computer-scoped AI provider probes; Server stores/authorizes/materializes only and records closed receipts',
	true,
	false,
	'server',
	false,
	NULL,
	'provider_computer_probe_v0'
) ON CONFLICT ("key") DO NOTHING;
