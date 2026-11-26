import { Inject, Injectable, Module } from "@nestjs/common";
import type { InferenceRunnerConfig } from "@mozaik-ai/core";
import { ConfigModule } from "../config/config.module.js";
import { ConfigService } from "../config/config.service.js";
import { createSupportedModels } from "./models.js";
import { StubInferenceRunner } from "./stub-inference.runner.js";

@Injectable()
export class InferenceService {
  readonly config: InferenceRunnerConfig;
  readonly mode: "stub" | "live";

  constructor(@Inject(ConfigService) config: ConfigService,
    @Inject(StubInferenceRunner) stub: StubInferenceRunner) {
    this.mode = config.env.INFERENCE;
    this.config = this.mode === "stub" ? { runner: stub } : {
      supportedModels: createSupportedModels(config.env.OPENAI_API_KEY),
    };
  }
}

@Module({
  imports: [ConfigModule], providers: [InferenceService, StubInferenceRunner],
  exports: [InferenceService, StubInferenceRunner],
})
export class InferenceModule {}
