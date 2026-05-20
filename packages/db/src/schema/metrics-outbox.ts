import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sites } from "./sites.ts";

/**
 * Metrics outbox — transactional outbox for Redis sum increments.
 *
 * One row per `(site, year, month)` pair touched by an accepted ingest batch.
 * Written in the **same Postgres transaction** as the measurement INSERTs, so
 * the consumer commit guarantees the increment intent is durable. A separate
 * worker (`apps/metrics-relay`) drains this table and applies `HINCRBYFLOAT` to
 * the per-site Redis hash (`metrics:<site_id>` → `<yyyymm>`) via a Lua script
 * that is SETNX-guarded on the outbox row id (exactly-once HINCRBY under
 * at-least-once relay delivery).
 *
 * Why a sibling table to `outbox` instead of reusing it:
 *   - The existing `outbox` table is drained by `apps/outbox-relay`, which
 *     POSTs each row to the alerting HTTP receiver. A "Redis increment" is a
 *     different *kind* of work (HINCRBYFLOAT, not HTTP). Mixing them in one
 *     table would require event-type discrimination in every poll query and
 *     would couple two unrelated relays' progress.
 *   - Matches the existing system_alerts/outbox split: one table per relay
 *     responsibility.
 *
 * Why one row per (site, year, month) and not per batch:
 *   - A batch can span the site-local month boundary (e.g. readings recorded
 *     in March arriving in early April when the site is in `America/Edmonton`).
 *     Each affected month needs its own HINCRBYFLOAT to its own hash field.
 *   - Late-arrivals into past months also produce a row (we don't filter by
 *     "is this the current month?"). Past-month rows land in their field of
 *     the Redis hash and stay there harmlessly — the read path only consults
 *     the current month, but no extra logic is needed to suppress them.
 *
 * Relay poll pattern (mirrors `outbox` exactly):
 *   SELECT … FROM metrics_outbox
 *   WHERE delivered_at IS NULL AND available_at <= now()
 *   ORDER BY available_at
 *   FOR UPDATE SKIP LOCKED
 *
 * Exponential backoff on transient Redis failure; on exhaustion, the relay
 * inserts a `system_alerts` row and freezes the metrics_outbox row (never
 * deleted — forensic audit trail).
 *
 * (year, month) are in the site's local calendar (sites.timezone, IANA), to
 * match the bucketing in `site_monthly_emissions` (see that file's docstring).
 */
export const metricsOutbox = pgTable(
  "metrics_outbox",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    siteId: bigint("site_id", { mode: "bigint" })
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    year: integer("year").notNull(),
    month: integer("month").notNull(),
    deltaKg: numeric("delta_kg", { precision: 18, scale: 6 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    availableAt: timestamp("available_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    monthRange: check("metrics_outbox_month_range", sql`${t.month} BETWEEN 1 AND 12`),
    pendingIdx: index("metrics_outbox_pending_idx")
      .on(t.availableAt)
      .where(sql`delivered_at IS NULL`),
  }),
);

export type MetricsOutboxEvent = typeof metricsOutbox.$inferSelect;
export type NewMetricsOutboxEvent = typeof metricsOutbox.$inferInsert;
