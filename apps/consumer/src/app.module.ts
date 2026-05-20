import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { LoggerModule } from "nestjs-pino";
import { AppConfigModule } from "./config/app-config.module.ts";
import { AppConfigService } from "./config/app-config.service.ts";
import { ConsumerEnvSchema } from "./config/env.schema.ts";
import { DbModule } from "./db/db.module.ts";
import { IngestModule } from "./ingest/ingest.module.ts";
import { KafkaConsumerModule } from "./kafka/kafka-consumer.module.ts";
import { SystemAlertsModule } from "./system-alerts/system-alerts.module.ts";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Look for .env in the repo root (two levels above apps/consumer/src).
      envFilePath: ["../../.env", ".env"],
      validate: (config) => {
        const result = ConsumerEnvSchema.safeParse(config);
        if (!result.success) {
          throw new Error(`Invalid environment configuration: ${result.error.message}`);
        }
        return result.data;
      },
    }),
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => {
        const isProduction = config.isProduction;
        return {
          pinoHttp: {
            transport: isProduction
              ? undefined
              : {
                  target: "pino-pretty",
                  options: {
                    colorize: true,
                    singleLine: true,
                    translateTime: "SYS:standard",
                  },
                },
            level: process.env.LOG_LEVEL ?? (isProduction ? "info" : "debug"),
          },
        };
      },
      imports: [AppConfigModule],
    }),
    DbModule,
    SystemAlertsModule,
    IngestModule,
    KafkaConsumerModule,
  ],
})
export class AppModule {}
