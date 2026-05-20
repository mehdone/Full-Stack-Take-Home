import type { IncomingMessage } from "node:http";
import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import { LoggerModule } from "nestjs-pino";
import { BootstrapModule } from "./bootstrap/bootstrap.module.ts";
import { AllExceptionsFilter } from "./common/envelope/http-exception.filter.ts";
import { ResponseInterceptor } from "./common/envelope/response.interceptor.ts";
import { RequestIdMiddleware } from "./common/middleware/request-id.middleware.ts";
import { AppConfigModule } from "./config/app-config.module.ts";
import type { Env } from "./config/env.schema.ts";
import { EnvSchema } from "./config/env.schema.ts";
import { DbModule } from "./db/db.module.ts";
import { HealthModule } from "./health/health.module.ts";
import { IngestModule } from "./ingest/ingest.module.ts";
import { KafkaModule } from "./kafka/kafka.module.ts";
import { RedisModule } from "./redis/redis.module.ts";
import { SitesModule } from "./sites/sites.module.ts";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Look for .env in the repo root (two levels above apps/api/src).
      // Falls back gracefully to environment variables already in process.env
      // (set by the shell, Docker, or CI). ignoreEnvFile: false is the default.
      envFilePath: ["../../.env", ".env"],
      validate: (config) => {
        const result = EnvSchema.safeParse(config);
        if (!result.success) {
          throw new Error(`Invalid environment configuration: ${result.error.message}`);
        }
        return result.data;
      },
    }),
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService<Env, true>) => {
        const isProduction = configService.get("NODE_ENV", { infer: true }) === "production";
        return {
          pinoHttp: {
            // Use the inbound x-request-id header if present, else generate a UUID.
            // pino-http runs before RequestIdMiddleware so we read the header directly here.
            // RequestIdMiddleware also sets req.id and echoes the header so all layers agree.
            genReqId: (req: IncomingMessage): string => {
              const header = req.headers["x-request-id"];
              const inbound = Array.isArray(header) ? header[0] : header;
              return inbound ?? crypto.randomUUID();
            },
            // Redact sensitive fields
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                "req.body.measurements[*]",
              ],
              remove: true,
            },
            // Bind request_id as a top-level field on every log line
            customProps: (req: IncomingMessage) => ({
              request_id: (req as IncomingMessage & { id?: string }).id,
            }),
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
            // LOG_LEVEL env override wins (used to silence logs in tests);
            // otherwise debug in dev, info in prod.
            level: process.env.LOG_LEVEL ?? (isProduction ? "info" : "debug"),
          },
        };
      },
      imports: [ConfigModule],
    }),
    DbModule,
    RedisModule,
    KafkaModule,
    HealthModule,
    SitesModule,
    IngestModule,
    BootstrapModule,
  ],
  providers: [
    // Globals registered as providers so they apply in every bootstrap context
    // (production `main.ts`, Jest test harness, future microservice transports).
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes({ path: "*", method: RequestMethod.ALL });
  }
}
