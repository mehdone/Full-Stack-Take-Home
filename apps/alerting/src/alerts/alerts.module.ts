import { Module } from "@nestjs/common";
import { AlertsController } from "./alerts.controller.ts";
import { AlertsService } from "./alerts.service.ts";

@Module({
  controllers: [AlertsController],
  providers: [AlertsService],
})
export class AlertsModule {}
