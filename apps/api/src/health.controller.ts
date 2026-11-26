import { Controller, Get, Inject } from "@nestjs/common";
import type { HealthResponse } from "@budget-crew/shared";
import { ConfigService } from "./config/config.service.js";

@Controller("health")
export class HealthController {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  @Get()
  get(): HealthResponse {
    return {
      status: "ok",
      version: this.config.env.APP_VERSION,
      inference: this.config.env.INFERENCE,
    };
  }
}
