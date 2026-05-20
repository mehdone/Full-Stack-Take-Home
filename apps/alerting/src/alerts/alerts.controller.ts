import { AlertEnvelopeBusinessSchema, AlertEnvelopeSystemSchema } from "@highwood/contracts";
import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Logger,
  Post,
} from "@nestjs/common";
import { AlertsService } from "./alerts.service.ts";

@Controller("alerts")
export class AlertsController {
  private readonly logger = new Logger(AlertsController.name);

  constructor(@Inject(AlertsService) private readonly alertsService: AlertsService) {}

  /**
   * POST /alerts/business
   *
   * Receives an outbox-relay delivery. Validates via Zod, then delegates to
   * AlertsService which handles deduplication and structured logging.
   *
   * Returns 200 (not 202) so HTTP-level retries don't replay on a timeout.
   * The relay treats any 2xx as success.
   */
  @Post("business")
  @HttpCode(200)
  handleBusiness(@Body() body: unknown): { status: string; duplicate?: boolean } {
    const result = AlertEnvelopeBusinessSchema.safeParse(body);
    if (!result.success) {
      this.logger.warn({
        event: "alert.invalid_payload",
        path: "/alerts/business",
        issues: result.error.issues,
      });
      throw new BadRequestException({
        error: "invalid_payload",
        issues: result.error.issues,
      });
    }

    return this.alertsService.handleBusiness(result.data);
  }

  /**
   * POST /alerts/system
   *
   * Receives a system-alerts-relay delivery. No deduplication — each row is
   * a distinct operational event.
   */
  @Post("system")
  @HttpCode(200)
  handleSystem(@Body() body: unknown): { status: string } {
    const result = AlertEnvelopeSystemSchema.safeParse(body);
    if (!result.success) {
      this.logger.warn({
        event: "system_alert.invalid_payload",
        path: "/alerts/system",
        issues: result.error.issues,
      });
      throw new BadRequestException({
        error: "invalid_payload",
        issues: result.error.issues,
      });
    }

    return this.alertsService.handleSystem(result.data);
  }
}
