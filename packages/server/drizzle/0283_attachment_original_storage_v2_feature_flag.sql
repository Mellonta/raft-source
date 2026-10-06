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
	'attachment_original_storage_v2',
	'Route newly-created attachment originals to the dedicated attachment bucket; persisted keys remain authoritative',
	true,
	false,
	'server',
	true,
	NULL,
	'attachment_original_storage_v2'
) ON CONFLICT ("key") DO NOTHING;
