import { Controller, Get } from "@nestjs/common";
import type { HealthResponse } from "@budget-crew/shared";

@Controller("health")
export class HealthController {
  @Get()
  get(): HealthResponse {
    return {
      status: "ok",
      version: process.env.APP_VERSION ?? "dev",
      inference: process.env.INFERENCE === "live" ? "live" : "stub",
    };
  }
}
