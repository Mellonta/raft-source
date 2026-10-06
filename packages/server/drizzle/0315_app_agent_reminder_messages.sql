CREATE TABLE "agent_private_surfaces" (
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"server_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_private_surfaces_agent_id_kind_pk" PRIMARY KEY("agent_id","kind"),
	CONSTRAINT "agent_private_surfaces_kind_valid" CHECK ("agent_private_surfaces"."kind" IN ('reminders'))
);
--> statement-breakpoint
CREATE TABLE "app_agent_messages" (
	"client_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"message_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_agent_messages_client_id_agent_id_idempotency_key_pk" PRIMARY KEY("client_id","agent_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "agent_private_surfaces" ADD CONSTRAINT "agent_private_surfaces_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_private_surfaces" ADD CONSTRAINT "agent_private_surfaces_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_private_surfaces" ADD CONSTRAINT "agent_private_surfaces_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_agent_messages" ADD CONSTRAINT "app_agent_messages_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_agent_messages" ADD CONSTRAINT "app_agent_messages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_agent_messages" ADD CONSTRAINT "app_agent_messages_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_private_surfaces_channel" ON "agent_private_surfaces" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_app_agent_messages_message" ON "app_agent_messages" USING btree ("message_id");