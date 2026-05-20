import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Logger as PinoLogger } from "nestjs-pino";
import { AppModule } from "./app.module.ts";
import { AppConfigService } from "./config/app-config.service.ts";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Disable Nest's default logger during bootstrap — pino takes over after init
    bufferLogs: true,
  });

  // Switch to pino logger
  app.useLogger(app.get(PinoLogger));

  const config = app.get(AppConfigService);

  // CORS configuration
  if (config.isProduction) {
    const origins = config.corsAllowedOrigins;
    if (origins.length > 0) {
      app.enableCors({ origin: origins, credentials: true });
    } else {
      // Production with no origins configured → deny all cross-origin
      app.enableCors({ origin: false });
    }
  } else {
    // Dev: permissive
    app.enableCors({ origin: true, credentials: true });
  }

  // Global exception filter + response interceptor are wired as APP_FILTER /
  // APP_INTERCEPTOR providers in AppModule so they apply identically in tests
  // and in production. main.ts no longer needs to wire them explicitly.

  // Enable graceful shutdown hooks (calls onApplicationShutdown)
  app.enableShutdownHooks();

  const port = config.port;
  await app.listen(port);

  const logger = new Logger("Bootstrap");
  logger.log({ event: "api.started", port, nodeEnv: config.nodeEnv });
}

bootstrap().catch((err) => {
  console.error("Fatal bootstrap error", err);
  process.exit(1);
});
