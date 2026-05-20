import type { AlertEnvelopeBusiness, AlertEnvelopeSystem } from "@highwood/contracts";
import { Injectable, Logger } from "@nestjs/common";
import { DedupStore } from "./dedup.store.ts";

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  /**
   * Bounded LRU dedupe set for business alerts.
   * Key = `${event_type}:${payload.batch_id}`.
   *
   * Rationale: the relay can retry a row it already delivered if it crashes
   * before marking `delivered_at`. The sink returns 200 on duplicate so the
   * relay marks it delivered and stops retrying (idempotent sink = correct
   * at-least-once semantics).
   */
  private readonly dedupStore = new DedupStore(10_000);

  handleBusiness(alert: AlertEnvelopeBusiness): { status: string; duplicate?: boolean } {
    const dedupKey = `${alert.event_type}:${alert.payload.batch_id}`;

    // Suppress no-op batches (measurements_inserted == 0) as well as true
    // duplicates. Both cases return 200 so the relay marks the row delivered.
    if (alert.payload.measurements_inserted === 0) {
      this.logger.log({
        event: "alert.noop_suppressed",
        outbox_id: alert.outbox_id,
        event_type: alert.event_type,
        aggregate_id: alert.aggregate_id,
        batch_id: alert.payload.batch_id,
        site_slug: alert.payload.site_slug,
        reason: "measurements_inserted == 0",
      });
      return { status: "ok", duplicate: true };
    }

    const isNew = this.dedupStore.add(dedupKey);

    if (!isNew) {
      this.logger.log({
        event: "alert.duplicate_suppressed",
        outbox_id: alert.outbox_id,
        event_type: alert.event_type,
        aggregate_id: alert.aggregate_id,
        batch_id: alert.payload.batch_id,
        site_slug: alert.payload.site_slug,
        dedup_key: dedupKey,
      });
      return { status: "ok", duplicate: true };
    }

    this.logger.log({
      event: "alert.delivered",
      outbox_id: alert.outbox_id,
      event_type: alert.event_type,
      aggregate_id: alert.aggregate_id,
      batch_id: alert.payload.batch_id,
      site_slug: alert.payload.site_slug,
      measurements_inserted: alert.payload.measurements_inserted,
      measurements_submitted: alert.payload.measurements_submitted,
      sum_kg_co2e: alert.payload.sum_kg_co2e,
      received_at_ms: alert.payload.received_at_ms,
      persisted_at_ms: alert.payload.persisted_at_ms,
    });

    return { status: "ok" };
  }

  handleSystem(alert: AlertEnvelopeSystem): { status: string } {
    // System alerts have no deduplication requirement — each row is a distinct
    // operational event. Log and return.
    this.logger.log({
      event: "system_alert.delivered",
      system_alert_id: alert.system_alert_id,
      alert_type: alert.alert_type,
      severity: alert.severity,
      payload: alert.payload,
    });

    return { status: "ok" };
  }
}
