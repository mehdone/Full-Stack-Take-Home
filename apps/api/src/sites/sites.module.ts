import { Module } from "@nestjs/common";
import { MetricsService } from "./metrics.service.ts";
import { SitesController } from "./sites.controller.ts";
import { SitesService } from "./sites.service.ts";

@Module({
  controllers: [SitesController],
  providers: [SitesService, MetricsService],
})
export class SitesModule {}
