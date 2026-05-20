import type { DbClient } from "@highwood/db";
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { sql } from "drizzle-orm";
import { AppConfigService } from "../config/app-config.service.ts";
import { DB_CLIENT } from "../db/db.tokens.ts";

/**
 * SystemAlertsRelayService
 *
 * Parallel to OutboxRelayService but scans the `system_alerts` table and
 * POSTs each row to POST {ALERTING_URL}/alerts/system.
 *
 * Key difference from the outbox relay: on exhaustion, we do NOT recurse into
 * inserting another system_alerts row (that would cause an infinite loop).
 * Instead we emit a structured `system_alerts_exhausted` log line and freeze
 * the row (set available_at far in the future) so it stops being picked up.
 */
@Injectable()
export class SystemAlertsRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SystemAlertsRelayService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    @Inject(DB_CLIENT) private readonly dbClient: DbClient,
    @Inject(AppConfigService) private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.tick()
        .catch((err: unknown) => {
          this.logger.error({
            event: "system_alerts_relay.tick_error",
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          this.running = false;
        });
    }, this.config.pollIntervalMs);

    this.logger.log({
      event: "system_alerts_relay.started",
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
    this.logger.log({ event: "system_alerts_relay.stopped" });
  }

  // ---------------------------------------------------------------------------
  // Poll tick
  // ---------------------------------------------------------------------------

  private async tick(): Promise<void> {
    const batchSize = this.config.batchSize;

    await this.dbClient.db.transaction(async (tx) => {
      const rows = await tx.execute(sql`
        SELECT id, alert_type, severity, payload, attempts
        FROM system_alerts
        WHERE delivered_at IS NULL
          AND available_at <= now()
        ORDER BY available_at
        LIMIT ${sql.raw(String(batchSize))}
        FOR UPDATE SKIP LOCKED
      `);

      if (rows.length === 0) return;

      this.logger.debug({
        event: "system_alerts_relay.tick",
        rowsLocked: rows.length,
      });

      for (const row of rows) {
        await this.deliverRow(tx, row as unknown as SystemAlertRow);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Per-row delivery
  // ---------------------------------------------------------------------------

  private async deliverRow(
    tx: Parameters<Parameters<DbClient["db"]["transaction"]>[0]>[0],
    row: SystemAlertRow,
  ): Promise<void> {
    const { id, alert_type, severity, payload, attempts } = row;
    const systemAlertId = String(id);

    try {
      const body = JSON.stringify({
        system_alert_id: systemAlertId,
        alert_type,
        severity,
        payload,
      });

      const res = await fetch(`${this.config.alertingUrl}/alerts/system`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Idempotency-Key": systemAlertId,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });

      if (res.ok) {
        await tx.execute(sql`
          UPDATE system_alerts
          SET delivered_at = now()
          WHERE id = ${id}
        `);

        this.logger.log({
          event: "system_alerts_relay.delivered",
          system_alert_id: systemAlertId,
          alert_type,
          severity,
          http_status: res.status,
        });
      } else {
        const errText = await res.text().catch(() => "<unreadable>");
        await this.handleFailure(tx, row, `HTTP ${res.status}: ${errText}`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.handleFailure(tx, row, errMsg);
    }
  }

  // ---------------------------------------------------------------------------
  // Failure handling — backoff + exhaustion (no recursive system_alerts write)
  // ---------------------------------------------------------------------------

  private async handleFailure(
    tx: Parameters<Parameters<DbClient["db"]["transaction"]>[0]>[0],
    row: SystemAlertRow,
    errMsg: string,
  ): Promise<void> {
    const { id, alert_type, severity, attempts } = row;
    const systemAlertId = String(id);
    const newAttempts = Number(attempts) + 1;

    this.logger.warn({
      event: "system_alerts_relay.delivery_failed",
      system_alert_id: systemAlertId,
      alert_type,
      severity,
      attempts: newAttempts,
      error: errMsg,
    });

    if (newAttempts >= this.config.maxAttempts) {
      // Exhausted — log structured error but do NOT write another system_alerts
      // row (infinite loop). Freeze the row.
      this.logger.error({
        event: "system_alerts_exhausted",
        system_alert_id: systemAlertId,
        alert_type,
        severity,
        attempts: newAttempts,
        last_error: errMsg,
        note: "Row frozen; operator must intervene to reset available_at or delete.",
      });

      await tx.execute(sql`
        UPDATE system_alerts
        SET attempts     = ${newAttempts},
            last_error   = ${errMsg},
            available_at = now() + interval '1 year'
        WHERE id = ${id}
      `);

      return;
    }

    const backoffSeconds = Math.min(
      2 ** newAttempts * this.config.backoffBaseSeconds,
      this.config.backoffCapSeconds,
    );
    const jitterSeconds = backoffSeconds * 0.2 * Math.random();
    const totalSeconds = backoffSeconds + jitterSeconds;

    await tx.execute(sql`
      UPDATE system_alerts
      SET attempts     = ${newAttempts},
          last_error   = ${errMsg},
          available_at = now() + (${totalSeconds} || ' seconds')::interval
      WHERE id = ${id}
    `);
  }
}

// ---------------------------------------------------------------------------
// Internal row shape
// ---------------------------------------------------------------------------

interface SystemAlertRow {
  id: bigint | number;
  alert_type: string;
  severity: string;
  payload: unknown;
  attempts: number;
}
