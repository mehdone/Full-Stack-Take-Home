import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.ts";
import { AppConfigService } from "./config/app-config.service.ts";

const bootstrapLogger = new Logger("Bootstrap");

async function bootstrap(): Promise<void> {
  // No HTTP endpoint for the primary function (Redis writer). HTTP is up only
  // for the /health endpoint that compose / orchestrators probe. Port 4102 to
  // sit alongside outbox-relay (4101).
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  app.enableShutdownHooks();

  const config = app.get(AppConfigService);

  const healthPort = 4102;
  await app.listen(healthPort);

  bootstrapLogger.log({
    event: "metrics_relay.started",
    healthPort,
    nodeEnv: config.nodeEnv,
    pollIntervalMs: config.pollIntervalMs,
    batchSize: config.batchSize,
    redisUrl: config.redisUrl,
  });
}

bootstrap().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[Bootstrap] Fatal error: ${msg}`);
  process.exit(1);
});
