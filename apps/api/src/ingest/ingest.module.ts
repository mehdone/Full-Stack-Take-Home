import { Module } from "@nestjs/common";
import { IngestController } from "./ingest.controller.ts";
import { IngestService } from "./ingest.service.ts";

@Module({
  controllers: [IngestController],
  providers: [IngestService],
})
export class IngestModule {}
