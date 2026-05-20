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
 * `year` and `month` are in the **site's local calendar** (sites.timezone, IANA),
 * not UTC. Monthly emissions are a geographic/regulatory concept, so a reading at
 * 23:30 March 31 in `America/Edmonton` (= 05:30 April 1 UTC) belongs to the March
 * row, not April. Every writer (consumer's stale-flag UPSERT, the future ETL's
 * month-close SUM, and the read path's current-month live SUM) must derive the
 * (year, month) using the site's timezone, otherwise totals straddle the
 * boundary incorrectly.
 *
 * Populated by the nightly ETL in `apps/etl`: at 02:00 UTC on day 2 of month M+1
 * (M = the prior site-local month), the job closes month M for every site.
 * `GET /sites/:slug/metrics` then computes total-to-date = SUM(this table for
 * prior site-local months) + SUM(measurements for current site-local month).
 *
 * `stale = true` marks rows invalidated by a late-arriving measurement; an hourly
 * recompute job scans the partial index `WHERE stale = true` and rebuilds only the
 * affected rows.
 *
 * The current site-local month is **not** present in this table until the ETL
 * closes it — the consumer skips the UPSERT for current-month measurements
 * because there is no cache row to invalidate and `GET /metrics` reads the
 * current month live from `measurements`.
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
