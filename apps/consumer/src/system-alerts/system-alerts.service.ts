import type { DbClient } from "@highwood/db";
import { systemAlerts } from "@highwood/db";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { DB_CLIENT } from "../db/db.tokens.ts";

/**
 * Thin helper for writing operational alerts to the `system_alerts` table.
 *
 * Used on defend-in-depth paths (unknown site slug reaching the consumer,
 * malformed payload after JSON parse, etc.). Writes are best-effort — a
 * failure here must never crash the consumer or block offset commits.
 */
@Injectable()
export class SystemAlertsService {
  private readonly logger = new Logger(SystemAlertsService.name);

  constructor(@Inject(DB_CLIENT) private readonly dbClient: DbClient) {}

  async insertAlert(
    alertType: string,
    payload: Record<string, unknown>,
    severity: "info" | "warn" | "critical" = "warn",
  ): Promise<void> {
    try {
      await this.dbClient.db.insert(systemAlerts).values({
        alertType,
        severity,
        payload,
      });
      this.logger.log({ event: "system_alert.inserted", alertType, severity });
    } catch (err) {
      // Non-fatal — log and continue. The consumer must not crash on alert
      // insertion failure.
      this.logger.error({
        event: "system_alert.insert_failed",
        alertType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
