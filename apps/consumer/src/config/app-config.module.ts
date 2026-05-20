import { Global, Module } from "@nestjs/common";
import { AppConfigService } from "./app-config.service.ts";

/**
 * @Global() so AppConfigService is injectable everywhere without re-importing
 * this module in each feature module — mirrors the API's pattern.
 */
@Global()
@Module({
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
