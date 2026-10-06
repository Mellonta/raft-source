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
	'provider_probe_enforcement_v0',
	'Wave 3: launch enforcement on matching fresh Computer probe receipts; retires server-side provider discovery/test I/O',
	true,
	false,
	'server',
	false,
	NULL,
	'provider_probe_enforcement_v0'
) ON CONFLICT ("key") DO NOTHING;
