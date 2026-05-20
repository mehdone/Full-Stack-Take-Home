import type { IncomingMessage } from "node:http";
import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { LoggerModule } from "nestjs-pino";
import { AlertsModule } from "./alerts/alerts.module.ts";
import { RequestIdMiddleware } from "./common/middleware/request-id.middleware.ts";
import { AppConfigModule } from "./config/app-config.module.ts";
import { AppConfigService } from "./config/app-config.service.ts";
import { AlertingEnvSchema } from "./config/env.schema.ts";
import { HealthModule } from "./health/health.module.ts";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ["../../.env", ".env"],
      validate: (config) => {
        const result = AlertingEnvSchema.safeParse(config);
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
            genReqId: (req: IncomingMessage): string => {
              const header = req.headers["x-request-id"];
              const inbound = Array.isArray(header) ? header[0] : header;
              return inbound ?? crypto.randomUUID();
            },
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
    HealthModule,
    AlertsModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes({ path: "*", method: RequestMethod.ALL });
  }
}
