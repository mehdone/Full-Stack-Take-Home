import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AppConfigService } from "./app-config.service.ts";

/**
 * AppConfigModule — globally exports AppConfigService so every module can
 * inject it without re-declaring it as a local provider.
 *
 * Explicitly imports ConfigModule to ensure ConfigService is resolved before
 * AppConfigService's constructor runs. ConfigModule.forRoot(isGlobal:true) in
 * AppModule makes ConfigService available globally, but AppConfigModule must
 * still declare the import so NestJS sequences initialization correctly.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
