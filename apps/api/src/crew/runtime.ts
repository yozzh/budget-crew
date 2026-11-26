import {
  defineRuntime, RuntimeState,
  type InferenceInput, type InferenceRunnerConfig, type Participant, type SemanticEvent,
} from "@mozaik-ai/core";

export class BudgetState extends RuntimeState {}

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
