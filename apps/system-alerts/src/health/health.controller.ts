import type { DbClient } from "@highwood/db";
import { Controller, Get, Inject, Logger } from "@nestjs/common";
import { DB_CLIENT } from "../db/db.tokens.ts";

@Controller("health")
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(@Inject(DB_CLIENT) private readonly client: DbClient) {}

  @Get()
  async check(): Promise<{ status: string; db: string }> {
    let db = "down";
    try {
      await this.client.sql`SELECT 1`;
      db = "ok";
    } catch (err) {
      this.logger.warn({
        event: "health.db_check_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { status: "ok", db };
  }
}
