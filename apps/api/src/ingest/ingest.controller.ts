import { type IngestAccepted, IngestBatchSchema } from "@highwood/contracts";
import { Body, Controller, HttpCode, HttpStatus, Inject, Logger, Post } from "@nestjs/common";
import { ZodValidationPipe } from "../common/validation/zod-validation.pipe.ts";
import { IngestService } from "./ingest.service.ts";

@Controller("ingest")
export class IngestController {
  private readonly logger = new Logger(IngestController.name);

  constructor(@Inject(IngestService) private readonly ingestService: IngestService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async ingest(
    @Body(new ZodValidationPipe(IngestBatchSchema)) body: typeof IngestBatchSchema._type,
  ): Promise<IngestAccepted> {
    return this.ingestService.ingest(body);
  }
}
