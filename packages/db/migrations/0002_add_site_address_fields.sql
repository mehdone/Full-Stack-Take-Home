-- =============================================================================
-- 0002_add_site_address_fields.sql — structured address columns on sites
-- =============================================================================
--
-- Replaces the single free-form `location_label` column with structured address
-- fields. `country` is required for every site (ISO 3166-1 alpha-2, e.g. 'US')
-- and gets a DEFAULT 'US' so the migration can backfill any existing rows in
-- dev/test environments without a separate seed step. The application layer
-- (Zod) requires country on every insert, so the default is purely a migration
-- backfill — new sites must explicitly specify it.
--
-- state / city / postal_code are nullable because international addressing
-- varies (some countries have no state subdivisions; postal codes range from
-- 0 to 10+ characters with no consistent format).
--
-- Authored by hand because drizzle-kit's generator runs interactive prompts
-- ("rename vs drop") that don't work through a non-TTY pipe; following the
-- pattern established by 0001_partition_measurements.sql.
-- =============================================================================

ALTER TABLE "sites" ADD COLUMN "country" text NOT NULL DEFAULT 'US';
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "state" text;
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "city" text;
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "postal_code" text;
--> statement-breakpoint
ALTER TABLE "sites" DROP COLUMN "location_label";
