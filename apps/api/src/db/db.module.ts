import { type DbClient, createClient } from "@highwood/db";
import { Global, Inject, Logger, Module, type OnApplicationShutdown } from "@nestjs/common";
import { AppConfigService } from "../config/app-config.service.ts";
import { DB_CLIENT } from "./db.tokens.ts";

const dbClientProvider = {
  provide: DB_CLIENT,
  inject: [AppConfigService],
  useFactory: (config: AppConfigService): DbClient => {
    return createClient(config.databaseUrl);
  },
};

@Global()
@Module({
  providers: [dbClientProvider],
  exports: [DB_CLIENT],
})
export class DbModule implements OnApplicationShutdown {
  private readonly logger = new Logger(DbModule.name);

  constructor(@Inject(DB_CLIENT) private readonly client: DbClient) {}

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log({ event: "db.shutdown", signal: signal ?? "UNKNOWN" });
    await this.client.close();
  }
}
