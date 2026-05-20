import { bigserial, numeric, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Sites — emission-producing facilities.
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
    country: text("country").notNull().default("US"),
    state: text("state"),
    city: text("city"),
    postalCode: text("postal_code"),
    latitude: numeric("latitude", { precision: 9, scale: 6 }).notNull(),
    longitude: numeric("longitude", { precision: 9, scale: 6 }).notNull(),
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
