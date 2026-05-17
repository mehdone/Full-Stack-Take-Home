import { sql } from "drizzle-orm";
import { bigserial, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * System alerts — operational-event channel parallel to `outbox` but scoped to
 * platform-internal events (clock skew, downstream failure, etc.).
 *
 * Same retry-aware shape as `outbox`; delivered by a separate worker in
 * `apps/system-alerts` so business-event delivery and operational-alert delivery
 * don't share fate.
 *
 * `severity` is kept as free `text` (validated at the edge as
 * `'info' | 'warn' | 'critical'`) rather than a Postgres enum — easier to extend
 * without an `ALTER TYPE` migration.
 */
export const systemAlerts = pgTable(
  "system_alerts",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    alertType: text("alert_type").notNull(),
    severity: text("severity").notNull(),
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
    pendingIdx: index("system_alerts_pending_idx")
      .on(t.availableAt)
      .where(sql`delivered_at IS NULL`),
  }),
);

export type SystemAlert = typeof systemAlerts.$inferSelect;
export type NewSystemAlert = typeof systemAlerts.$inferInsert;
