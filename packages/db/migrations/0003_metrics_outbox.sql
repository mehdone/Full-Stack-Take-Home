-- =============================================================================
-- 0003_metrics_outbox.sql — transactional outbox for Redis sum increments
-- =============================================================================
--
-- Mirror of the existing `outbox` table shape, but drained by a different worker
-- (`apps/metrics-relay`) that applies `HINCRBYFLOAT` to a per-site Redis hash
-- representing pre-aggregated emissions per (site, year, month). The cache lets
-- `GET /sites/:slug/metrics` answer the current-month component in O(1) without
-- a partition scan of `measurements`.
--
-- Postgres remains the source of truth. The relay is the bridge that keeps
-- Redis coherent with measurements that have actually been committed to the DB.
-- One row is INSERTed in the same transaction as the measurement batch
-- (consumer ingest path) for every distinct site-local (year, month) touched
-- by the batch. If the consumer commits, the row exists; the relay will
-- eventually apply the HINCRBYFLOAT exactly-once via a SETNX-guarded Lua
-- script (the relay's idempotency boundary).
--
-- Authored by hand following the convention of 0001 / 0002 (drizzle-kit
-- generator is interactive-only; not used here for consistency).
-- =============================================================================

CREATE TABLE "metrics_outbox" (
  "id"            bigserial PRIMARY KEY,
  "site_id"       bigint NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE,
  "year"          integer NOT NULL,
  "month"         integer NOT NULL,
  "delta_kg"      numeric(18, 6) NOT NULL,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "available_at"  timestamptz NOT NULL DEFAULT now(),
  "attempts"      integer NOT NULL DEFAULT 0,
  "last_error"    text,
  "delivered_at"  timestamptz,
  CONSTRAINT "metrics_outbox_month_range" CHECK ("month" BETWEEN 1 AND 12)
);
--> statement-breakpoint

-- Partial index: keep the relay's poll scan cheap regardless of how many
-- historical rows accumulate. Mirrors `outbox_pending_idx`.
CREATE INDEX "metrics_outbox_pending_idx"
  ON "metrics_outbox" ("available_at")
  WHERE "delivered_at" IS NULL;
