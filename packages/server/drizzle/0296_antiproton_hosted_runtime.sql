-- Hosted agent runtime is now configured per deployment (base URL fixed by
-- DEPLOYMENT_ENV + ANTIPROTON_PROVISIONING_TOKEN), so the per-server provider
-- config table goes (owner decision: no backward compatibility needed).
DROP TABLE "agent_runtime_provider_configs" CASCADE;--> statement-breakpoint
-- Server-stage flag, default OFF. Enable per server with a `server` stage
-- allow rule in the Feature Flag Admin; no server ids are seeded here.
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
	'antiproton_hosted_runtime',
	'Create external agents that run on the antiproton hosted runtime (raft-agent-provider.v1); also requires ANTIPROTON_PROVISIONING_TOKEN on the deployment',
	true,
	false,
	'server',
	false,
	NULL,
	'antiproton_hosted_runtime'
) ON CONFLICT ("key") DO NOTHING;
