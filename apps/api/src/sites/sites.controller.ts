import {
  CreateSiteSchema,
  type SiteMetrics,
  type SiteResponse,
  SitesListQuerySchema,
  type SitesListResponse,
} from "@highwood/contracts";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ZodValidationPipe } from "../common/validation/zod-validation.pipe.ts";
import { MetricsService } from "./metrics.service.ts";
import { SitesService } from "./sites.service.ts";

@Controller("sites")
export class SitesController {
  private readonly logger = new Logger(SitesController.name);

  constructor(
    @Inject(SitesService) private readonly sitesService: SitesService,
    @Inject(MetricsService) private readonly metricsService: MetricsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(CreateSiteSchema)) body: typeof CreateSiteSchema._type,
  ): Promise<SiteResponse> {
    const site = await this.sitesService.create(body);
    this.logger.log({ event: "site.create.accepted", slug: site.slug });
    return site;
  }

  @Get()
  async list(
    @Query(new ZodValidationPipe(SitesListQuerySchema)) query: typeof SitesListQuerySchema._type,
  ): Promise<SitesListResponse> {
    return this.metricsService.listSites(query.limit, query.cursor);
  }

  @Get(":slug/metrics")
  async metrics(@Param("slug") slug: string): Promise<SiteMetrics> {
    return this.metricsService.getSiteMetrics(slug);
  }
}
