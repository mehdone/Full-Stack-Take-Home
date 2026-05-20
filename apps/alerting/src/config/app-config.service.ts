import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AlertingEnv } from "./env.schema.ts";

@Injectable()
export class AppConfigService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<AlertingEnv, true>) {}

  get nodeEnv(): AlertingEnv["NODE_ENV"] {
    return this.config.get("NODE_ENV", { infer: true });
  }

  get port(): number {
    return this.config.get("ALERTING_PORT", { infer: true });
  }

  get isProduction(): boolean {
    return this.nodeEnv === "production";
  }
}
