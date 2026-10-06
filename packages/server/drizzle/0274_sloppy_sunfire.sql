CREATE TABLE "release_note_audit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"release_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"client_id" text NOT NULL,
	"action" text NOT NULL,
	"revision" integer,
	"reason" text NOT NULL,
	"entry_deltas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_note_drafts" (
	"release_id" uuid PRIMARY KEY NOT NULL,
	"entries" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_note_mutation_receipts" (
	"actor_id" text NOT NULL,
	"client_id" text NOT NULL,
	"key" text NOT NULL,
	"request_digest" text NOT NULL,
	"release_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"revision" integer,
	CONSTRAINT "release_note_mutation_receipts_actor_id_client_id_key_pk" PRIMARY KEY("actor_id","client_id","key")
);
--> statement-breakpoint
CREATE TABLE "release_note_revision_items" (
	"release_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"entry_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"type" text NOT NULL,
	"text" text NOT NULL,
	"emphasis" boolean DEFAULT false NOT NULL,
	CONSTRAINT "release_note_revision_items_release_id_revision_entry_id_pk" PRIMARY KEY("release_id","revision","entry_id"),
	CONSTRAINT "release_note_revision_items_release_id_revision_ordinal_unique" UNIQUE("release_id","revision","ordinal")
);
--> statement-breakpoint
CREATE TABLE "release_note_revisions" (
	"release_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"snapshot_hash" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_note_revisions_release_id_revision_pk" PRIMARY KEY("release_id","revision")
);
--> statement-breakpoint
CREATE TABLE "release_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"release_key" text NOT NULL,
	"version" text,
	"tag" text,
	"date" date NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"current_revision" integer,
	"retracted_at" timestamp with time zone,
	CONSTRAINT "release_notes_release_key_unique" UNIQUE("release_key"),
	CONSTRAINT "release_notes_version_unique" UNIQUE("version"),
	CONSTRAINT "release_notes_tag_unique" UNIQUE("tag")
);
--> statement-breakpoint
ALTER TABLE "release_note_audit" ADD CONSTRAINT "release_note_audit_release_id_release_notes_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."release_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_note_drafts" ADD CONSTRAINT "release_note_drafts_release_id_release_notes_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."release_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_note_mutation_receipts" ADD CONSTRAINT "release_note_mutation_receipts_release_id_release_notes_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."release_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_note_revision_items" ADD CONSTRAINT "release_note_revision_items_release_id_revision_release_note_revisions_release_id_revision_fk" FOREIGN KEY ("release_id","revision") REFERENCES "public"."release_note_revisions"("release_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_note_revisions" ADD CONSTRAINT "release_note_revisions_release_id_release_notes_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."release_notes"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Immutability: published revisions and their items are append-only evidence.
CREATE OR REPLACE FUNCTION release_note_revision_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'release_note_revisions are immutable (%)', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER release_note_revisions_immutable
  BEFORE UPDATE OR DELETE ON release_note_revisions
  FOR EACH ROW EXECUTE FUNCTION release_note_revision_immutable();
--> statement-breakpoint
CREATE TRIGGER release_note_revision_items_immutable
  BEFORE UPDATE OR DELETE ON release_note_revision_items
  FOR EACH ROW EXECUTE FUNCTION release_note_revision_immutable();
