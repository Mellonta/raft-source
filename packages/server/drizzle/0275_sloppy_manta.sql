ALTER TABLE "release_note_audit" ADD COLUMN "actor_type" text;--> statement-breakpoint
ALTER TABLE "release_note_audit" ALTER COLUMN "actor_type" SET DEFAULT 'human';--> statement-breakpoint
UPDATE "release_note_audit" SET "actor_type" = 'human' WHERE "actor_type" IS NULL;--> statement-breakpoint
ALTER TABLE "release_note_audit" ALTER COLUMN "actor_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "release_note_audit" ALTER COLUMN "actor_type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "release_note_mutation_receipts" ADD COLUMN "actor_type" text;--> statement-breakpoint
ALTER TABLE "release_note_mutation_receipts" ALTER COLUMN "actor_type" SET DEFAULT 'human';--> statement-breakpoint
UPDATE "release_note_mutation_receipts" SET "actor_type" = 'human' WHERE "actor_type" IS NULL;--> statement-breakpoint
ALTER TABLE "release_note_mutation_receipts" ALTER COLUMN "actor_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "release_note_mutation_receipts" ALTER COLUMN "actor_type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "release_note_mutation_receipts" DROP CONSTRAINT "release_note_mutation_receipts_actor_id_client_id_key_pk";--> statement-breakpoint
ALTER TABLE "release_note_mutation_receipts" ADD CONSTRAINT "release_note_mutation_receipts_actor_type_actor_id_client_id_key_pk" PRIMARY KEY("actor_type","actor_id","client_id","key");
