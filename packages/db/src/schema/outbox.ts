import { sql } from "drizzle-orm";
import { bigserial, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Outbox — transactional outbox for business events emitted by the ingest consumer.
 *
 * One row per ingest batch (not per measurement). Payload carries
 * `(site_id, batch_id, count_inserted, sum_kg)`. Written in the same transaction
 * as the measurement inserts so the alerting notification can never be lost.
 *
 * Relay (in `apps/alerting`) polls:
 *   SELECT ... FROM outbox
 *   WHERE delivered_at IS NULL AND available_at <= now()
 *   FOR UPDATE SKIP LOCKED
 *
 * Exponential backoff is implemented by rewriting `available_at` on transient failure
 * and bumping `attempts`. The partial index keeps the relay scan cheap regardless of
 * how many historical rows accumulate.
 */
export const outbox = pgTable(
  "outbox",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    eventType: text("event_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    availableAt: timestamp("available_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    pendingIdx: index("outbox_pending_idx").on(t.availableAt).where(sql`delivered_at IS NULL`),
  }),
);

export type OutboxEvent = typeof outbox.$inferSelect;
export type NewOutboxEvent = typeof outbox.$inferInsert;
