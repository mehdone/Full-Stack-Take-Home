import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  timestamp,
} from "drizzle-orm/pg-core";
import { sites } from "./sites.ts";

/**
 * Site monthly emissions — cached per-(site, year, month) aggregate of measurements.
 *
 * Populated by the nightly ETL in `apps/etl`: at 02:00 UTC on day 2 of month M+1, the
 * job closes month M for every site. `GET /sites/:slug/metrics` then computes
 * total-to-date = SUM(this table for prior months) + SUM(measurements for current month).
 *
 * `stale = true` marks rows invalidated by a late-arriving measurement; an hourly
 * recompute job scans the partial index `WHERE stale = true` and rebuilds only the
 * affected rows.
 *
 * This is the deliberate scaling deviation from the README: recomputing
 * `total_emissions_to_date` on every ingest does not scale to 100M+ rows; cached
 * monthly aggregates do. Documented prominently in ARCHITECTURE.md.
 */
export const siteMonthlyEmissions = pgTable(
  "site_monthly_emissions",
  {
    siteId: bigint("site_id", { mode: "bigint" })
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    year: integer("year").notNull(),
    month: integer("month").notNull(),
    totalKg: numeric("total_kg", { precision: 18, scale: 6 }).notNull().default("0"),
    stale: boolean("stale").notNull().default(false),
    computedAt: timestamp("computed_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.siteId, t.year, t.month],
      name: "site_monthly_emissions_pkey",
    }),
    monthRange: check("site_monthly_emissions_month_range", sql`${t.month} BETWEEN 1 AND 12`),
    staleIdx: index("site_monthly_emissions_stale_idx")
      .on(t.siteId, t.year, t.month)
      .where(sql`stale = true`),
  }),
);

export type SiteMonthlyEmission = typeof siteMonthlyEmissions.$inferSelect;
export type NewSiteMonthlyEmission = typeof siteMonthlyEmissions.$inferInsert;
