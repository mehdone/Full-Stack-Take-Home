# Outbox Relay — Backoff, Exhaustion & Recovery

← Back to [`ARCHITECTURE.md`](../../ARCHITECTURE.md). This document expands §10.

## 1. Schema

```
outbox
├─ id           bigserial   PK
├─ event_type   text        e.g. "ingest.batch.persisted"
├─ aggregate_id text        the site_slug (lets downstream group by site)
├─ payload      jsonb       { site_slug, batch_id, measurements_inserted, sum_kg, ... }
├─ created_at   timestamptz default now()
├─ available_at timestamptz default now()  -- when the relay may attempt this row
├─ attempts     int         default 0
├─ last_error   text        nullable
└─ delivered_at timestamptz nullable      -- non-null = done

-- Partial index keeps the relay scan cheap regardless of historical row count:
CREATE INDEX outbox_pending_idx
  ON outbox (available_at)
  WHERE delivered_at IS NULL;
```

`system_alerts` has the same shape with `alert_type` instead of `event_type` and a `severity` enum.

## 2. The poll loop

```sql
BEGIN;

SELECT id, event_type, aggregate_id, payload, attempts
FROM outbox
WHERE delivered_at IS NULL
  AND available_at <= now()
ORDER BY available_at
FOR UPDATE SKIP LOCKED
LIMIT $OUTBOX_BATCH_SIZE;

-- (in app) for each selected row:
--   try POST /alerts/business with body=payload and header
--      X-Idempotency-Key: outbox_id
--   on 2xx:
--      UPDATE outbox SET delivered_at = now() WHERE id = ?
--      EMIT in-process event 'outbox.delivered' for metrics
--   on non-2xx or network error:
--      UPDATE outbox
--        SET attempts = attempts + 1,
--            last_error = $err,
--            available_at = now() + ($backoff seconds)
--        WHERE id = ?
--      if attempts + 1 >= $MAX_ATTEMPTS:
--        INSERT INTO system_alerts(alert_type, ..., payload=jsonb_build_object('outbox_id', id, ...))
--        UPDATE outbox SET available_at = now() + interval '1 year' WHERE id = ?
--        (freeze; never delete — forensic audit trail)

COMMIT;
```

`FOR UPDATE SKIP LOCKED` is the key primitive: multiple relay replicas can run safely without coordination. `SKIP LOCKED` returns only uncontended rows, letting each replica process a disjoint subset in parallel. The cost is a slightly higher miss rate under heavy load (a row another replica is processing isn't seen by this scan), which is acceptable for a background job.

## 3. Backoff formula

```
delay_seconds = min(2^attempts * BASE, CAP) + jitter
jitter        = random() * 0.2 * delay_seconds      // ±20% jitter
```

Defaults (tunable via env):

| Env | Default | Meaning |
|---|---|---|
| `OUTBOX_BACKOFF_BASE_SECONDS` | 1 | First retry waits ~1s |
| `OUTBOX_BACKOFF_CAP_SECONDS` | 300 | Capped at 5 minutes |
| `OUTBOX_MAX_ATTEMPTS` | 10 | After this many, escalate to system_alerts |

| Attempt | Computed delay | Cumulative wall time |
|---|---|---|
| 1 | ~1s | ~1s |
| 2 | ~2s | ~3s |
| 3 | ~4s | ~7s |
| 4 | ~8s | ~15s |
| 5 | ~16s | ~31s |
| 6 | ~32s | ~63s |
| 7 | ~64s | ~127s |
| 8 | ~128s | ~255s |
| 9 | ~256s (clamped to 300) | ~555s |
| 10 | 300s | ~855s |

After 10 attempts (~14 minutes wall clock), the row freezes and `system_alerts` carries the exhaustion event.

## 4. Exhaustion semantics

When `attempts >= MAX_ATTEMPTS`:

1. A `system_alerts` row is inserted (`alert_type = 'outbox_exhausted'`) with the outbox id and the last error.
2. The outbox row's `available_at` is set ~1 year in the future. The row is **frozen, not deleted** — preserved as a forensic audit trail.
3. The system-alerts relay attempts to deliver the exhaustion event to the alerting receiver.

If the system-alerts relay also fails MAX_ATTEMPTS times, it **does not** write a recursive `system_alerts` row. Instead it logs a structured `system_alerts_exhausted` event and freezes the system_alerts row. This breaks the recursive-failure loop (§10.3 in MEHDI.md).

## 5. Manual recovery

Operator action when a frozen row is later determined to be deliverable:

```sql
-- Inspect first
SELECT id, event_type, aggregate_id, last_error, attempts, available_at
FROM outbox
WHERE delivered_at IS NULL
  AND available_at > now() + interval '6 months'    -- "frozen" heuristic
ORDER BY created_at;

-- Unfreeze a specific row to retry now
UPDATE outbox
   SET available_at = now(),
       attempts = 0,
       last_error = NULL
 WHERE id = $row_id;
```

The relay picks it up on its next tick. If it succeeds, `delivered_at` is set; if it fails again, normal backoff resumes.

## 6. Receiver-side guarantees

`apps/alerting` is the downstream HTTP sink. It guarantees:

- **Idempotency.** Dedupe key = `(event_type, aggregate_id, payload.batch_id)` for business events; system events use `(alert_type, aggregate_id, payload.outbox_id)`. Backed by an in-memory bounded LRU (10k entries, FIFO eviction). Sufficient for relay-driven retries that occur within seconds; outside that window, the relay should have marked the row delivered already.
- **No-op suppression.** Business events with `payload.measurements_inserted == 0` are logged as `alert.duplicate_suppressed` and not propagated downstream. This is the contract that lets the consumer write an outbox row on every transaction (including duplicate-batch retries) without spamming downstream.
- **Structured logs only.** No DB, no queue. The receiver is a sink that an operator can swap for a real PagerDuty / Slack / email integration without changing the relay.

## 7. Why this beats direct emit (one more time, for the skeptical reader)

```
Without outbox (direct emit):
  BEGIN; INSERT measurements; COMMIT;   ← data persisted
  ... process crashes here ...
  POST /alerts/business                  ← never runs
                                            DATA EXISTS, ALERT LOST.

With outbox:
  BEGIN;
    INSERT measurements;
    INSERT outbox;                       ← intent persisted in same TX
  COMMIT;
  ... process crashes here ...
  (relay picks up the row eventually, delivers it, marks delivered_at)
                                            ALERT EVENTUALLY DELIVERED.
```

The cost is one extra INSERT per batch + a background worker. The benefit is "alerts as durable as measurements" — which is the regulatory-grade behavior the OGMP 2.0 context demands.
