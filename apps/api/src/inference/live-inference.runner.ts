import { defineRuntime, RuntimeState, type InferenceRunner } from "@mozaik-ai/core";
import type { ConfigService } from "../config/config.service.js";
import { createSupportedModels } from "./models.js";

/** Override this provider with an InferenceRunner to exercise mixed routing offline. */
export const LIVE_INFERENCE_RUNNER = Symbol("LIVE_INFERENCE_RUNNER");

class InferenceRuntimeState extends RuntimeState {}

export function createLiveInferenceRunner(config: ConfigService): InferenceRunner {
  // Core 6 exports DefaultInferenceRunner but not its validator. Its runtime factory
  // supplies the actual default runner and validation without starting any agent or cloud loop.
  return defineRuntime<InferenceRuntimeState>().initializeRuntime({
    state: new InferenceRuntimeState(),
    inferenceRunnerConfig: {
      supportedModels: createSupportedModels(config.env.OPENAI_API_KEY, config.env.OPENAI_BASE_URL),
    },
  }).getInferenceRunner();
}
