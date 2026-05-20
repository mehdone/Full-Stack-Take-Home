import { Module } from "@nestjs/common";
import { DocsController } from "./docs.controller.ts";

@Module({
  controllers: [DocsController],
})
export class OpenApiModule {}
