import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { LoggerModule } from "nestjs-pino";
import { AppConfigModule } from "./config/app-config.module.ts";
import { AppConfigService } from "./config/app-config.service.ts";
import { OutboxRelayEnvSchema } from "./config/env.schema.ts";
import { DbModule } from "./db/db.module.ts";
import { HealthModule } from "./health/health.module.ts";
import { RelayModule } from "./relay/relay.module.ts";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ["../../.env", ".env"],
      validate: (config) => {
        const result = OutboxRelayEnvSchema.safeParse(config);
        if (!result.success) {
          throw new Error(`Invalid environment configuration: ${result.error.message}`);
        }
        return result.data;
      },
    }),
    AppConfigModule,
    EventEmitterModule.forRoot(),
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
    HealthModule,
    RelayModule,
  ],
})
export class AppModule {}
