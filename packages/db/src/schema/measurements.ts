import {
  bigint,
  bigserial,
  index,
  numeric,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { siteEmissionPoints } from "./site-emission-points.ts";
import { sites } from "./sites.ts";

/**
 * Measurements — append-only emission readings.
 *
 * **PARTITIONED BY RANGE (recorded_at) — monthly.** Drizzle does not model
 * `PARTITION BY` natively; the table as Drizzle generates it is replaced wholesale by
 * the hand-written migration `0001_partition_measurements.sql`, which recreates the
 * table with the same columns/indexes plus the `PARTITION BY RANGE (recorded_at)`
 * clause and seeds four monthly partitions + a DEFAULT catch-all.
 *
 * Postgres requires the partition key to appear in any UNIQUE or PRIMARY KEY
 * constraint on a partitioned table — hence:
 *   - PRIMARY KEY (id, recorded_at)
 *   - UNIQUE (batch_id, emission_point_id, recorded_at)  -- authoritative dedupe key
 *
 * The unique on `(batch_id, emission_point_id, recorded_at)` is what
 * `INSERT ... ON CONFLICT DO NOTHING` keys off at the consumer. `recorded_at` is
 * microsecond-precision `timestamptz`; collisions on the same emission point at the
 * same microsecond are implausible for physical sensors.
 *
 * Read pattern is per-site time-series: hence `(site_id, recorded_at DESC)`.
 * `(batch_id)` is a debug/ops index for tracing a producer's batch end-to-end.
 *
 * Values are `numeric(18, 6)` in kg CO2e — the single canonical unit. Unit conversion
 * happens at the API edge before publish to Kafka.
 */
export const measurements = pgTable(
  "measurements",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    siteId: bigint("site_id", { mode: "bigint" })
      .notNull()
      .references(() => sites.id, { onDelete: "restrict" }),
    emissionPointId: bigint("emission_point_id", { mode: "bigint" })
      .notNull()
      .references(() => siteEmissionPoints.id, { onDelete: "restrict" }),
    batchId: uuid("batch_id").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "date" }).notNull(),
    value: numeric("value", { precision: 18, scale: 6 }).notNull(),
  },
  (t) => ({
    batchPointTimeUnique: uniqueIndex("measurements_batch_point_time_unique").on(
      t.batchId,
      t.emissionPointId,
      t.recordedAt,
    ),
    siteRecordedAtIdx: index("measurements_site_recorded_at_idx").on(t.siteId, t.recordedAt.desc()),
    batchIdIdx: index("measurements_batch_id_idx").on(t.batchId),
  }),
);

export type Measurement = typeof measurements.$inferSelect;
export type NewMeasurement = typeof measurements.$inferInsert;
