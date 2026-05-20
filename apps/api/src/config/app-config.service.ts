import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "./env.schema.ts";

@Injectable()
export class AppConfigService {
  // Explicit @Inject ensures DI works even when emitDecoratorMetadata isn't
  // available (e.g. tsx dev mode uses esbuild, which doesn't emit metadata).
  constructor(@Inject(ConfigService) private readonly config: ConfigService<Env, true>) {}

  get nodeEnv(): Env["NODE_ENV"] {
    return this.config.get("NODE_ENV", { infer: true });
  }

  get port(): number {
    return this.config.get("PORT", { infer: true });
  }

  get databaseUrl(): string {
    return this.config.get("DATABASE_URL", { infer: true });
  }

  get isProduction(): boolean {
    return this.nodeEnv === "production";
  }

  get corsAllowedOrigins(): string[] {
    const raw = this.config.get("CORS_ALLOWED_ORIGINS", { infer: true });
    if (!raw) return [];
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  get redisUrl(): string {
    return this.config.get("REDIS_URL", { infer: true });
  }

  get kafkaBrokers(): string[] {
    return this.config
      .get("KAFKA_BROKERS", { infer: true })
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  get ingestTopic(): string {
    return this.config.get("INGEST_TOPIC", { infer: true });
  }

  get batchDedupeTtlSeconds(): number {
    return this.config.get("BATCH_DEDUPE_TTL_SECONDS", { infer: true });
  }
}
