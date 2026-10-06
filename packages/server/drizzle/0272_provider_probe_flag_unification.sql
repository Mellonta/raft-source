DELETE FROM "feature_flag_rules" WHERE "flag_key" IN ('provider_computer_probe_v0', 'provider_probe_enforcement_v0');--> statement-breakpoint
DELETE FROM "feature_flags" WHERE "key" IN ('provider_computer_probe_v0', 'provider_probe_enforcement_v0');
