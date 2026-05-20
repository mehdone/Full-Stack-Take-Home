import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ConsumerEnv } from "./env.schema.ts";

@Injectable()
export class AppConfigService {
  // Explicit @Inject ensures DI resolves correctly under tsx (esbuild) which
  // doesn't emit decorator metadata.
  constructor(@Inject(ConfigService) private readonly config: ConfigService<ConsumerEnv, true>) {}

  get nodeEnv(): ConsumerEnv["NODE_ENV"] {
    return this.config.get("NODE_ENV", { infer: true });
  }

  get databaseUrl(): string {
    return this.config.get("DATABASE_URL", { infer: true });
  }

  get isProduction(): boolean {
    return this.nodeEnv === "production";
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

  get consumerGroupId(): string {
    return this.config.get("CONSUMER_GROUP_ID", { infer: true });
  }
}
