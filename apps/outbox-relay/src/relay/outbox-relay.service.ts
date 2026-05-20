import type { DbClient } from "@highwood/db";
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { sql } from "drizzle-orm";
import { AppConfigService } from "../config/app-config.service.ts";
import { DB_CLIENT } from "../db/db.tokens.ts";

/**
 * Payload emitted on the NestJS event bus for every successfully delivered
 * outbox row. Downstream listeners (logging, metrics, etc.) can subscribe
 * without coupling to the HTTP delivery path.
 */
export interface OutboxDeliveredEvent {
  outboxId: string;
  eventType: string;
  aggregateId: string;
}

/**
 * OutboxRelayService
 *
 * Polls the `outbox` table with a `FOR UPDATE SKIP LOCKED` scan so multiple
 * relay replicas can run safely without double-delivering. For each pending
 * row it:
 *
 *  1. POSTs to the alerting receiver (POST {ALERTING_URL}/alerts/business).
 *  2a. On 2xx — marks `delivered_at = now()` inside the same transaction.
 *  2b. On failure — increments `attempts`, writes `last_error`, and pushes
 *      `available_at` forward with exponential backoff + jitter.
 *  3. When `attempts` would reach `OUTBOX_MAX_ATTEMPTS`, writes a
 *     `system_alerts` row instead of retrying and leaves the outbox row alone
 *     (forensic visibility; do NOT delete).
 *
 * After successful delivery, emits an `outbox.delivered` NestJS event so
 * in-process listeners can react without polling.
 */
@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    @Inject(DB_CLIENT) private readonly dbClient: DbClient,
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(EventEmitter2) private readonly events: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      if (this.running) return; // skip tick if previous tick is still in-flight
      this.running = true;
      this.tick()
        .catch((err: unknown) => {
          this.logger.error({
            event: "outbox_relay.tick_error",
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          this.running = false;
        });
    }, this.config.pollIntervalMs);

    this.logger.log({
      event: "outbox_relay.started",
      pollIntervalMs: this.config.pollIntervalMs,
      batchSize: this.config.batchSize,
      alertingUrl: this.config.alertingUrl,
    });
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.log({ event: "outbox_relay.stopped" });
  }

  private async tick(): Promise<void> {
    const batchSize = this.config.batchSize;

    // Single transaction per tick: lock rows, deliver, update in one round-trip.
    await this.dbClient.db.transaction(async (tx) => {
      // SELECT … FOR UPDATE SKIP LOCKED ensures no other relay replica picks the
      // same rows. The partial index (WHERE delivered_at IS NULL) keeps the scan
      // O(pending) rather than O(total).
      // Use now() directly in SQL — passing a JS Date as a parameter doesn't
      // work with postgres-js's tagged-template interpolation.
      const rows = await tx.execute(sql`
        SELECT id, event_type, aggregate_id, payload, attempts
        FROM outbox
        WHERE delivered_at IS NULL
          AND available_at <= now()
        ORDER BY available_at
        LIMIT ${sql.raw(String(batchSize))}
        FOR UPDATE SKIP LOCKED
      `);

      if (rows.length === 0) return;

      this.logger.debug({
        event: "outbox_relay.tick",
        rowsLocked: rows.length,
      });

      for (const row of rows) {
        await this.deliverRow(tx, row as unknown as OutboxRow);
      }
    });
  }

  private async deliverRow(
    tx: Parameters<Parameters<DbClient["db"]["transaction"]>[0]>[0],
    row: OutboxRow,
  ): Promise<void> {
    const { id, event_type, aggregate_id, payload, attempts } = row;
    const outboxId = String(id);

    try {
      const body = JSON.stringify({
        outbox_id: outboxId,
        event_type,
        aggregate_id,
        payload,
      });

      const res = await fetch(`${this.config.alertingUrl}/alerts/business`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Idempotency-Key": outboxId,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });

      if (res.ok) {
        // Mark delivered inside the same transaction.
        await tx.execute(sql`
          UPDATE outbox
          SET delivered_at = now()
          WHERE id = ${id}
        `);

        this.logger.log({
          event: "outbox_relay.delivered",
          outbox_id: outboxId,
          event_type,
          aggregate_id,
          http_status: res.status,
        });

        // Emit in-process event for downstream listeners.
        this.events.emit("outbox.delivered", {
          outboxId,
          eventType: event_type,
          aggregateId: aggregate_id,
        } satisfies OutboxDeliveredEvent);
      } else {
        const errText = await res.text().catch(() => "<unreadable>");
        await this.handleFailure(tx, row, `HTTP ${res.status}: ${errText}`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.handleFailure(tx, row, errMsg);
    }
  }

  private async handleFailure(
    tx: Parameters<Parameters<DbClient["db"]["transaction"]>[0]>[0],
    row: OutboxRow,
    errMsg: string,
  ): Promise<void> {
    const { id, event_type, aggregate_id, attempts } = row;
    const outboxId = String(id);
    const newAttempts = Number(attempts) + 1;

    this.logger.warn({
      event: "outbox_relay.delivery_failed",
      outbox_id: outboxId,
      event_type,
      aggregate_id,
      attempts: newAttempts,
      error: errMsg,
    });

    if (newAttempts >= this.config.maxAttempts) {
      // Exhausted — write a system_alert and stop retrying.
      // Do NOT delete the outbox row; leave it for forensic visibility.
      this.logger.error({
        event: "outbox_relay.exhausted",
        outbox_id: outboxId,
        event_type,
        aggregate_id,
        attempts: newAttempts,
      });

      // Write the system_alert directly via the raw sql handle inside the tx.
      await tx.execute(sql`
        INSERT INTO system_alerts (alert_type, severity, payload)
        VALUES (
          'outbox_delivery_exhausted',
          'critical',
          ${JSON.stringify({ outbox_id: outboxId, event_type, aggregate_id, attempts: newAttempts, last_error: errMsg })}::jsonb
        )
      `);

      // Freeze the outbox row so subsequent ticks skip it (set available_at
      // far in the future; operator can reset manually).
      await tx.execute(sql`
        UPDATE outbox
        SET attempts    = ${newAttempts},
            last_error  = ${errMsg},
            available_at = now() + interval '1 day'
        WHERE id = ${id}
      `);

      return;
    }

    // Compute next attempt time: min(2^attempts * base, cap) seconds + jitter.
    const backoffSeconds = Math.min(
      2 ** newAttempts * this.config.backoffBaseSeconds,
      this.config.backoffCapSeconds,
    );
    // Add up to 20 % jitter to avoid thundering-herd when many rows fail at once.
    const jitterSeconds = backoffSeconds * 0.2 * Math.random();
    const totalSeconds = backoffSeconds + jitterSeconds;

    await tx.execute(sql`
      UPDATE outbox
      SET attempts     = ${newAttempts},
          last_error   = ${errMsg},
          available_at = now() + (${totalSeconds} || ' seconds')::interval
      WHERE id = ${id}
    `);
  }
}

interface OutboxRow {
  id: bigint | number;
  event_type: string;
  aggregate_id: string;
  payload: unknown;
  attempts: number;
}
