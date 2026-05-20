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
import type { Redis } from "../redis.module.ts";
import { REDIS_CLIENT } from "../redis.tokens.ts";

/**
 * MetricsRelayService
 *
 * Polls `metrics_outbox` with `FOR UPDATE SKIP LOCKED` so multiple replicas
 * can run safely without double-applying. For each pending row:
 *
 *  1. EVAL the SETNX-guarded Lua script (apps/metrics-relay/src/redis.module.ts)
 *     that atomically:
 *       a. SETNX a per-outbox-row idempotency guard.
 *       b. On first sight: HINCRBYFLOAT the per-site hash field, HEXPIRE the
 *          field with the 90-day TTL.
 *       c. Returns 1 if applied, 0 if previously applied.
 *  2a. On success or already-applied (Lua returned 1 or 0): UPDATE the outbox
 *      row's `delivered_at` in the same transaction.
 *  2b. On error (Redis down, script error): increment `attempts`, push
 *      `available_at` forward with exponential backoff + jitter.
 *  3. When `attempts` reaches MAX, writes a `system_alerts` row and freezes
 *     the metrics_outbox row (forensic visibility; do NOT delete).
 *
 * Why SETNX-guarded inside Lua: HINCRBYFLOAT is not idempotent. The relay's
 * `SELECT FOR UPDATE SKIP LOCKED → do work → UPDATE delivered_at` pattern
 * prevents two replicas from racing on the same row but does NOT cover the
 * crash window between the Redis call and the SQL UPDATE. The SETNX guard
 * makes re-application a no-op.
 */
@Injectable()
export class MetricsRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MetricsRelayService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    @Inject(DB_CLIENT) private readonly dbClient: DbClient,
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.tick()
        .catch((err: unknown) => {
          this.logger.error({
            event: "metrics_relay.tick_error",
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          this.running = false;
        });
    }, this.config.pollIntervalMs);

    this.logger.log({
      event: "metrics_relay.started",
      pollIntervalMs: this.config.pollIntervalMs,
      batchSize: this.config.batchSize,
    });
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.log({ event: "metrics_relay.stopped" });
  }

  private async tick(): Promise<void> {
    const batchSize = this.config.batchSize;

    await this.dbClient.db.transaction(async (tx) => {
      const rows = await tx.execute(sql`
        SELECT id, site_id, year, month, delta_kg, attempts
        FROM metrics_outbox
        WHERE delivered_at IS NULL
          AND available_at <= now()
        ORDER BY available_at
        LIMIT ${sql.raw(String(batchSize))}
        FOR UPDATE SKIP LOCKED
      `);

      if (rows.length === 0) return;

      this.logger.debug({
        event: "metrics_relay.tick",
        rowsLocked: rows.length,
      });

      for (const row of rows) {
        await this.applyRow(tx, row as unknown as MetricsOutboxRow);
      }
    });
  }

  private async applyRow(
    tx: Parameters<Parameters<DbClient["db"]["transaction"]>[0]>[0],
    row: MetricsOutboxRow,
  ): Promise<void> {
    const { id, site_id, year, month, delta_kg } = row;
    const outboxId = String(id);
    const siteIdStr = String(site_id);
    const yyyymm = `${year}${String(month).padStart(2, "0")}`;
    const appliedKey = `applied:metrics_outbox:${outboxId}`;
    const hashKey = `metrics:${siteIdStr}`;

    try {
      const applied = await this.redis.metricsApplyIncrement(
        appliedKey,
        hashKey,
        yyyymm,
        delta_kg,
        this.config.appliedTtlSeconds,
        this.config.fieldTtlSeconds,
      );

      await tx.execute(sql`
        UPDATE metrics_outbox
        SET delivered_at = now()
        WHERE id = ${id}
      `);

      this.logger.log({
        event: applied === 1 ? "metrics_relay.applied" : "metrics_relay.already_applied",
        outbox_id: outboxId,
        site_id: siteIdStr,
        yyyymm,
        delta_kg,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.handleFailure(tx, row, errMsg);
    }
  }

  private async handleFailure(
    tx: Parameters<Parameters<DbClient["db"]["transaction"]>[0]>[0],
    row: MetricsOutboxRow,
    errMsg: string,
  ): Promise<void> {
    const { id, site_id, year, month, attempts } = row;
    const outboxId = String(id);
    const siteIdStr = String(site_id);
    const newAttempts = Number(attempts) + 1;

    this.logger.warn({
      event: "metrics_relay.apply_failed",
      outbox_id: outboxId,
      site_id: siteIdStr,
      year,
      month,
      attempts: newAttempts,
      error: errMsg,
    });

    if (newAttempts >= this.config.maxAttempts) {
      this.logger.error({
        event: "metrics_relay.exhausted",
        outbox_id: outboxId,
        site_id: siteIdStr,
        year,
        month,
        attempts: newAttempts,
      });

      await tx.execute(sql`
        INSERT INTO system_alerts (alert_type, severity, payload)
        VALUES (
          'metrics_outbox_exhausted',
          'critical',
          ${JSON.stringify({
            metrics_outbox_id: outboxId,
            site_id: siteIdStr,
            year,
            month,
            attempts: newAttempts,
            last_error: errMsg,
          })}::jsonb
        )
      `);

      // Freeze: push available_at far enough that the next tick won't see it.
      // Match outbox-relay's 1-day freeze; operator can reset manually.
      await tx.execute(sql`
        UPDATE metrics_outbox
        SET attempts     = ${newAttempts},
            last_error   = ${errMsg},
            available_at = now() + interval '1 day'
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
      UPDATE metrics_outbox
      SET attempts     = ${newAttempts},
          last_error   = ${errMsg},
          available_at = now() + (${totalSeconds} || ' seconds')::interval
      WHERE id = ${id}
    `);
  }
}

interface MetricsOutboxRow {
  id: bigint | number;
  site_id: bigint | number;
  year: number;
  month: number;
  delta_kg: string;
  attempts: number;
}
