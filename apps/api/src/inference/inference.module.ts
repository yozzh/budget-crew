import { Inject, Injectable, Module } from "@nestjs/common";
import type { InferenceRunner, InferenceRunnerConfig } from "@mozaik-ai/core";
import { ConfigModule } from "../config/config.module.js";
import { ConfigService } from "../config/config.service.js";
import { DEMO_CLOCK, DemoPolicy, type RequestRoute, type RequestSource } from "./demo-policy.js";
import { createLiveInferenceRunner, LIVE_INFERENCE_RUNNER } from "./live-inference.runner.js";
import { createSupportedModels } from "./models.js";
import { RoutingInferenceRunner } from "./routing-inference.runner.js";
import { StubInferenceRunner } from "./stub-inference.runner.js";

@Injectable()
export class InferenceService {
  readonly config: InferenceRunnerConfig;
  readonly mode: "stub" | "live";
  private readonly routes = new Map<string, RequestRoute>();

  constructor(@Inject(ConfigService) private readonly settings: ConfigService,
    @Inject(StubInferenceRunner) stub: StubInferenceRunner,
    @Inject(DemoPolicy) private readonly policy: DemoPolicy,
    @Inject(LIVE_INFERENCE_RUNNER) live: InferenceRunner) {
    this.mode = settings.env.INFERENCE;
    this.config = settings.env.PUBLIC_DEMO
      ? { runner: new RoutingInferenceRunner((id) => this.requestMode(id), live, stub) }
      : this.mode === "stub" ? { runner: stub } : {
        supportedModels: createSupportedModels(settings.env.OPENAI_API_KEY, settings.env.OPENAI_BASE_URL),
      };
  }

  selectRequest(requestId: string, source: RequestSource, ip: string): RequestRoute {
    const existing = this.routes.get(requestId);
    if (existing) return existing;
    const route = this.policy.choose(source, ip);
    this.routes.set(requestId, route);
    return route;
  }

  requestMode(requestId: string): "live" | "stub" {
    return this.routes.get(requestId)?.mode ?? (this.settings.env.PUBLIC_DEMO ? "stub" : this.mode);
  }
}

@Module({
  imports: [ConfigModule],
  providers: [
    InferenceService, StubInferenceRunner, DemoPolicy,
    { provide: DEMO_CLOCK, useValue: Date.now },
    {
      provide: LIVE_INFERENCE_RUNNER,
      useFactory: (config: ConfigService, stub: StubInferenceRunner) =>
        config.env.PUBLIC_DEMO && config.env.INFERENCE === "live" ? createLiveInferenceRunner(config) : stub,
      inject: [ConfigService, StubInferenceRunner],
    },
  ],
  exports: [InferenceService, StubInferenceRunner, DemoPolicy, DEMO_CLOCK, LIVE_INFERENCE_RUNNER],
})
export class InferenceModule {}
