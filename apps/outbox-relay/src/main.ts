import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.ts";
import { AppConfigService } from "./config/app-config.service.ts";

const bootstrapLogger = new Logger("Bootstrap");

async function bootstrap(): Promise<void> {
  // The outbox relay has no HTTP endpoint for its primary function (polling).
  // We still boot an HTTP server so the /health endpoint is reachable by
  // compose health-checks and orchestrators. Use a dedicated port (4101).
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  app.enableShutdownHooks();

  const config = app.get(AppConfigService);

  // Listen on a fixed port for health checks; not configurable to keep
  // the compose setup simple.
  const healthPort = 4101;
  await app.listen(healthPort);

  bootstrapLogger.log({
    event: "outbox_relay.started",
    healthPort,
    nodeEnv: config.nodeEnv,
    pollIntervalMs: config.pollIntervalMs,
    batchSize: config.batchSize,
    alertingUrl: config.alertingUrl,
  });
}

bootstrap().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[Bootstrap] Fatal error: ${msg}`);
  process.exit(1);
});
