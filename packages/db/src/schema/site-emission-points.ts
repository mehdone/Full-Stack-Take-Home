import { bigint, bigserial, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sites } from "./sites.ts";

/**
 * Site emission points — catalog of vents, flares, tanks, fugitive points, compressors,
 * etc. that produce measurements within a site.
 *
 * Auto-created on first sight inside the consumer transaction via
 * `INSERT ... ON CONFLICT (site_id, code) DO NOTHING RETURNING id` followed by a
 * SELECT on the conflict path. The `(site_id, code)` unique constraint is the upsert
 * target.
 *
 * Storing the code inline on every measurement row was rejected on storage grounds
 * (millions of rows/day × ~16 bytes/row). The normalized catalog keeps measurements
 * narrow (bigint FK = 8 bytes) and lets typo cleanup happen out-of-band.
 */
export const siteEmissionPoints = pgTable(
  "site_emission_points",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    siteId: bigint("site_id", { mode: "bigint" })
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => ({
    siteCodeUnique: uniqueIndex("site_emission_points_site_code_unique").on(t.siteId, t.code),
  }),
);

export type SiteEmissionPoint = typeof siteEmissionPoints.$inferSelect;
export type NewSiteEmissionPoint = typeof siteEmissionPoints.$inferInsert;
