import type { DbClient } from "@highwood/db";
import { Controller, Get, Inject, Logger } from "@nestjs/common";
import { DB_CLIENT } from "../db/db.tokens.ts";
import type { Redis } from "../redis.module.ts";
import { REDIS_CLIENT } from "../redis.tokens.ts";

@Controller("health")
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    @Inject(DB_CLIENT) private readonly client: DbClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get()
  async check(): Promise<{ status: string; db: string; redis: string }> {
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

    let redis = "down";
    try {
      const pong = await this.redis.ping();
      if (pong === "PONG") redis = "ok";
    } catch (err) {
      this.logger.warn({
        event: "health.redis_check_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return { status: "ok", db, redis };
  }
}
