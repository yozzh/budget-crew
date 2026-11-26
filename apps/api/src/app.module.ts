import { join } from "node:path";
import { Module } from "@nestjs/common";
import { ServeStaticModule } from "@nestjs/serve-static";
import { HealthController } from "./health.controller.js";
import { BudgetModule } from "./budget/budget.module.js";

// The built web app is served by the API, so the stand is one app container plus Centrifugo.
const webDist = process.env.WEB_DIST ?? join(import.meta.dirname, "../../web/dist");

@Module({
  imports: [BudgetModule, ServeStaticModule.forRoot({ rootPath: webDist, exclude: ["/api/{*path}"] })],
  controllers: [HealthController],
})
export class AppModule {}
