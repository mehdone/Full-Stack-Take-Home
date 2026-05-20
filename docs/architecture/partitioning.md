# `measurements` Partitioning

← Back to [`ARCHITECTURE.md`](../../ARCHITECTURE.md). This document expands §5.1 and §12.4.

## 1. Why RANGE-by-month?

The `measurements` table is the only table expected to reach 100M+ rows. The dominant query patterns are:

| Query | Filter |
|---|---|
| ETL month-close (nightly) | `recorded_at >= start_of_month AND recorded_at < end_of_month` |
| Hourly stale recompute | `site_id = ? AND recorded_at >= start_of_month AND recorded_at < end_of_month` |
| `GET /metrics` current-month live SUM | `site_id = ? AND recorded_at >= start_of_current_month` |
| Per-site time-series read | `site_id = ? AND recorded_at BETWEEN ?` |

All four are bounded by `recorded_at`. RANGE-partitioning by `recorded_at` monthly gives Postgres **partition pruning** — the planner walks only the months that overlap the query range, not the whole table. A 5-year-old site's "current month" query touches one partition.

Hash partitioning by `site_id` was considered. It distributes write load evenly but doesn't prune time-range scans, and the read path is time-bounded — so it loses on the dominant access pattern.

## 2. Partition layout

```
measurements                         -- partitioned parent, no data here
├─ measurements_y2026_m05            -- [2026-05-01, 2026-06-01)
├─ measurements_y2026_m06            -- [2026-06-01, 2026-07-01)
├─ measurements_y2026_m07            -- [2026-07-01, 2026-08-01)
├─ measurements_y2026_m08            -- [2026-08-01, 2026-09-01)
└─ measurements_default              -- catch-all for anything outside above
```

Current month + 3 ahead are pre-created. The DEFAULT partition exists as a safety net — if the rollover script fails, rows still land somewhere, surfacing the operational miss without corrupting correctness.

## 3. The unique-constraint-must-include-partition-key rule

PostgreSQL requires every unique or primary-key constraint on a partitioned table to include the partition key. So:

```sql
-- Cannot be just (id) on a partitioned table:
PRIMARY KEY (id, recorded_at)

-- Cannot be just (batch_id, emission_point_id) — must include recorded_at:
UNIQUE (batch_id, emission_point_id, recorded_at)
```

This shapes the idempotency story (§6.3 in MEHDI.md). Microsecond `recorded_at` makes same-point-same-instant collisions implausible for physical sensors, so this constraint behaves like a logical `UNIQUE (batch_id, emission_point_id)` in practice while satisfying the partitioning rule.

## 4. Monthly rollover

Lives in `apps/etl`. Runs day 1 of each month at 01:00 UTC (one hour before the nightly ETL at 02:00):

```sql
CREATE TABLE measurements_y2026_m09 PARTITION OF measurements
  FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');
```

If the rollover is missed, rows for that month land in `measurements_default`. The system stays correct; the operational deficit is visible (DEFAULT partition is non-empty), and recovery is the reclaim procedure below.

## 5. Reclaiming the DEFAULT partition

```sql
BEGIN;

-- Detach the DEFAULT partition so we can carve out the missed month
ALTER TABLE measurements DETACH PARTITION measurements_default;

-- Create the missed month partition with the same shape
CREATE TABLE measurements_y2026_m09 (LIKE measurements INCLUDING ALL);

-- Move the rows that should have been in m09 out of DEFAULT
INSERT INTO measurements_y2026_m09
  SELECT * FROM measurements_default
  WHERE recorded_at >= '2026-09-01' AND recorded_at < '2026-10-01';

DELETE FROM measurements_default
  WHERE recorded_at >= '2026-09-01' AND recorded_at < '2026-10-01';

-- Attach both partitions back
ALTER TABLE measurements ATTACH PARTITION measurements_y2026_m09
  FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');
ALTER TABLE measurements ATTACH PARTITION measurements_default DEFAULT;

COMMIT;
```

This is a manual operation. Documented here rather than automated because misuse can lose rows; an operator should review the SELECT count before running the DELETE.

## 6. Archival / drop-old strategy (future)

A common partitioning win is dropping old partitions wholesale rather than running `DELETE` row-by-row. Retention is currently unbounded (compliance audit trail), but the partition layout makes future retention policies trivial:

```sql
-- e.g. archive measurements older than 7 years
ALTER TABLE measurements DETACH PARTITION measurements_y2019_m01;
-- ... export, then DROP TABLE measurements_y2019_m01;
```

Not implemented; mentioned because it's a load-bearing reason RANGE-by-month was chosen.
