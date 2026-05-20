import { Controller, Get, Inject, Logger, ServiceUnavailableException } from "@nestjs/common";
import { HealthService, type HealthStatus } from "./health.service.ts";

@Controller("health")
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(@Inject(HealthService) private readonly healthService: HealthService) {}

  @Get()
  async check(): Promise<HealthStatus> {
    const result = await this.healthService.check();
    this.logger.log({
      event: "health.check",
      status: result.status,
      db: result.db,
      uptime_s: result.uptime_s,
    });

    if (result.status !== "ok") {
      // Throw a 503 so liveness/readiness probes (which read HTTP status)
      // see the degradation. The exception filter wraps the body as an
      // error envelope; `details` carries the per-component breakdown.
      throw new ServiceUnavailableException({
        message: "service degraded",
        details: result,
      });
    }

    return result;
  }
}
