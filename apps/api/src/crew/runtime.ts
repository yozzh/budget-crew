import {
  defineRuntime,
  type InferenceInput, type InferenceRunnerConfig, type Participant, type SemanticEvent,
} from "@mozaik-ai/core";

import type { BudgetState } from "../budget/budget.store.js";

export interface CrewRuntimeApi {
  initializeRuntime(config: { state: BudgetState; inferenceRunnerConfig?: InferenceRunnerConfig }): void;
  join(participant: Participant): void;
  sendEvent(event: SemanticEvent, senderId: string): void;
  runLoop(agentId: string, message: string, input: InferenceInput): void;
}

// One closure per Nest application; independent test applications do not share a singleton.
export function createCrewRuntime(): CrewRuntimeApi {
  return defineRuntime<BudgetState>();
}
