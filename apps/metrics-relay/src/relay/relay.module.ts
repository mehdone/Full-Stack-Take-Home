import { Module } from "@nestjs/common";
import { MetricsRelayService } from "./metrics-relay.service.ts";

@Module({
  providers: [MetricsRelayService],
})
export class RelayModule {}
