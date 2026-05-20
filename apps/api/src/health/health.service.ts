import type { DbClient } from "@highwood/db";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { DB_CLIENT } from "../db/db.tokens.ts";

export interface HealthStatus {
  status: "ok" | "degraded";
  db: "ok" | "down";
  uptime_s: number;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly startedAt = Date.now();

  constructor(@Inject(DB_CLIENT) private readonly client: DbClient) {}

  async check(): Promise<HealthStatus> {
    let dbStatus: "ok" | "down" = "down";

    try {
      await this.client.sql`SELECT 1`;
      dbStatus = "ok";
    } catch (err) {
      this.logger.warn({
        event: "health.db_check_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return {
      status: dbStatus === "ok" ? "ok" : "degraded",
      db: dbStatus,
      uptime_s: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }
}
