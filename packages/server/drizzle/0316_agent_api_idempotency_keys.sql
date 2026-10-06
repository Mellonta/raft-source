CREATE TABLE "agent_api_idempotency_keys" (
	"agent_id" uuid NOT NULL,
	"route" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_api_idempotency_keys_agent_id_route_idempotency_key_pk" PRIMARY KEY("agent_id","route","idempotency_key"),
	CONSTRAINT "agent_api_idempotency_keys_route_valid" CHECK ("agent_api_idempotency_keys"."route" IN ('taskCreate', 'actionPrepare'))
);
--> statement-breakpoint
ALTER TABLE "agent_api_idempotency_keys" ADD CONSTRAINT "agent_api_idempotency_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_api_idempotency_keys_created_at" ON "agent_api_idempotency_keys" USING btree ("created_at");