import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { SystemAlertsRelayEnv } from "./env.schema.ts";

@Injectable()
export class AppConfigService {
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<SystemAlertsRelayEnv, true>,
  ) {}

  get nodeEnv(): SystemAlertsRelayEnv["NODE_ENV"] {
    return this.config.get("NODE_ENV", { infer: true });
  }

  get databaseUrl(): string {
    return this.config.get("DATABASE_URL", { infer: true });
  }

  get isProduction(): boolean {
    return this.nodeEnv === "production";
  }

  get pollIntervalMs(): number {
    return this.config.get("SYSTEM_ALERTS_POLL_INTERVAL_MS", { infer: true });
  }

  get batchSize(): number {
    return this.config.get("SYSTEM_ALERTS_BATCH_SIZE", { infer: true });
  }

  get backoffBaseSeconds(): number {
    return this.config.get("SYSTEM_ALERTS_BACKOFF_BASE_SECONDS", { infer: true });
  }

  get backoffCapSeconds(): number {
    return this.config.get("SYSTEM_ALERTS_BACKOFF_CAP_SECONDS", { infer: true });
  }

  get maxAttempts(): number {
    return this.config.get("SYSTEM_ALERTS_MAX_ATTEMPTS", { infer: true });
  }

  get alertingUrl(): string {
    return this.config.get("ALERTING_URL", { infer: true });
  }
}
