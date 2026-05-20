import { Module } from "@nestjs/common";
import { BootstrapService } from "./bootstrap.service.ts";

@Module({
  providers: [BootstrapService],
})
export class BootstrapModule {}
