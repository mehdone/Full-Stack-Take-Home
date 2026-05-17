import { bigserial, numeric, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Sites — emission-producing facilities.
 *
 * External-facing identity is the client-supplied `slug` (URL-safe). The synthetic
 * `bigserial` `id` is the internal FK target. Slug shape is validated at the API edge
 * via Zod (regex `^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$`) — no DB CHECK constraint, so we
 * return a clean 4xx rather than a generic 23514 constraint violation.
 *
 * `latitude` / `longitude` use `numeric(9, 6)` — six decimal places ≈ 11 cm, more than
 * enough for site placement and avoiding PostGIS as a dependency.
 *
 * `timezone` is an IANA name (e.g. `America/Edmonton`), validated at the edge against
 * `Intl.supportedValuesOf('timeZone')`. Required for clock-skew detection on ingest:
 * a measurement timestamped in the future relative to the site's local time is rejected
 * and emits a `system_alerts` row.
 */
export const sites = pgTable(
  "sites",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    latitude: numeric("latitude", { precision: 9, scale: 6 }).notNull(),
    longitude: numeric("longitude", { precision: 9, scale: 6 }).notNull(),
    locationLabel: text("location_label"),
    timezone: text("timezone").notNull(),
    emissionLimit: numeric("emission_limit", { precision: 18, scale: 6 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => ({
    slugUnique: uniqueIndex("sites_slug_unique").on(t.slug),
  }),
);

export type Site = typeof sites.$inferSelect;
export type NewSite = typeof sites.$inferInsert;
