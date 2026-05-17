-- =============================================================================
-- 0001_partition_measurements.sql — hand-written partitioning migration
-- =============================================================================
--
-- Drizzle does not model `PARTITION BY` natively, so the `measurements` table
-- emitted by 0000_init.sql is the WRONG SHAPE — it is a normal table, not a
-- partitioned parent. This migration drops that table and recreates it as
--   CREATE TABLE measurements (...) PARTITION BY RANGE (recorded_at);
-- with identical columns, the composite primary key (id, recorded_at), the
-- authoritative dedupe unique constraint, and the per-site read-pattern index.
-- Indexes declared on the partitioned parent propagate to every child
-- partition automatically (Postgres >= 11 for indexes, >= 12 for FKs).
--
-- Partition layout (seeded at migration-generation time, 2026-05-16):
--   - measurements_y2026_m05  -- current month
--   - measurements_y2026_m06  -- current + 1
--   - measurements_y2026_m07  -- current + 2
--   - measurements_y2026_m08  -- current + 3
--   - measurements_default    -- catch-all safety net
--
-- Rollover responsibility:
--   A monthly maintenance job (Phase 5+, to live in `apps/etl`) extends the
--   window by creating the next month's partition before its boundary is
--   crossed. If the rollover job lapses, late or future-dated rows land in
--   `measurements_default` — the catch-all guarantees correctness while
--   surfacing the operational miss. Reclaim from default via:
--     ALTER TABLE measurements DETACH PARTITION measurements_default;
--     CREATE TABLE measurements_y<YYYY>_m<MM> (LIKE measurements INCLUDING ALL);
--     INSERT INTO measurements_y<YYYY>_m<MM>
--       SELECT * FROM measurements_default
--       WHERE recorded_at >= '<lo>' AND recorded_at < '<hi>';
--     DELETE FROM measurements_default
--       WHERE recorded_at >= '<lo>' AND recorded_at < '<hi>';
--     ALTER TABLE measurements ATTACH PARTITION measurements_y<YYYY>_m<MM>
--       FOR VALUES FROM ('<lo>') TO ('<hi>');
--     ALTER TABLE measurements ATTACH PARTITION measurements_default DEFAULT;
--
-- The unique index on (batch_id, emission_point_id, recorded_at) MUST include
-- `recorded_at` because Postgres requires uniques on a partitioned table to
-- include the partition key. This is the authoritative dedupe target for
-- ingest: `INSERT ... ON CONFLICT (batch_id, emission_point_id, recorded_at)
-- DO NOTHING`.
-- =============================================================================

DROP TABLE IF EXISTS "measurements" CASCADE;
--> statement-breakpoint

CREATE TABLE "measurements" (
  "id" bigserial NOT NULL,
  "site_id" bigint NOT NULL,
  "emission_point_id" bigint NOT NULL,
  "batch_id" uuid NOT NULL,
  "recorded_at" timestamp with time zone NOT NULL,
  "value" numeric(18, 6) NOT NULL,
  CONSTRAINT "measurements_pkey" PRIMARY KEY ("id", "recorded_at"),
  CONSTRAINT "measurements_site_id_sites_id_fk"
    FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "measurements_emission_point_id_site_emission_points_id_fk"
    FOREIGN KEY ("emission_point_id") REFERENCES "public"."site_emission_points"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION
) PARTITION BY RANGE ("recorded_at");
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "measurements_batch_point_time_unique"
  ON "measurements" USING btree ("batch_id", "emission_point_id", "recorded_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "measurements_site_recorded_at_idx"
  ON "measurements" USING btree ("site_id", "recorded_at" DESC NULLS LAST);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "measurements_batch_id_idx"
  ON "measurements" USING btree ("batch_id");
--> statement-breakpoint

-- ---- Monthly partitions (current + 3 ahead, bounds half-open [lo, hi)) ----

CREATE TABLE IF NOT EXISTS "measurements_y2026_m05"
  PARTITION OF "measurements"
  FOR VALUES FROM ('2026-05-01 00:00:00+00') TO ('2026-06-01 00:00:00+00');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "measurements_y2026_m06"
  PARTITION OF "measurements"
  FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "measurements_y2026_m07"
  PARTITION OF "measurements"
  FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "measurements_y2026_m08"
  PARTITION OF "measurements"
  FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "measurements_default"
  PARTITION OF "measurements" DEFAULT;
