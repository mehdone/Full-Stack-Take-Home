import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { MetricsRelayEnv } from "./env.schema.ts";

@Injectable()
export class AppConfigService {
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<MetricsRelayEnv, true>,
  ) {}

  get nodeEnv(): MetricsRelayEnv["NODE_ENV"] {
    return this.config.get("NODE_ENV", { infer: true });
  }

  get isProduction(): boolean {
    return this.nodeEnv === "production";
  }

  get databaseUrl(): string {
    return this.config.get("DATABASE_URL", { infer: true });
  }

  get redisUrl(): string {
    return this.config.get("REDIS_URL", { infer: true });
  }

  get pollIntervalMs(): number {
    return this.config.get("METRICS_RELAY_POLL_INTERVAL_MS", { infer: true });
  }

  get batchSize(): number {
    return this.config.get("METRICS_RELAY_BATCH_SIZE", { infer: true });
  }

  get backoffBaseSeconds(): number {
    return this.config.get("METRICS_RELAY_BACKOFF_BASE_SECONDS", { infer: true });
  }

  get backoffCapSeconds(): number {
    return this.config.get("METRICS_RELAY_BACKOFF_CAP_SECONDS", { infer: true });
  }

  get maxAttempts(): number {
    return this.config.get("METRICS_RELAY_MAX_ATTEMPTS", { infer: true });
  }

  get fieldTtlSeconds(): number {
    return this.config.get("METRICS_FIELD_TTL_SECONDS", { infer: true });
  }

  get appliedTtlSeconds(): number {
    return this.config.get("METRICS_APPLIED_TTL_SECONDS", { infer: true });
  }
}
