import {
  Agent, DeveloperMessageItem, ModelContext,
  type Participant, type SemanticEvent, type StructuredOutputFormat, type Tool,
} from "@mozaik-ai/core";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { InferenceService } from "../inference/inference.module.js";
import { CentrifugoPublisher } from "../realtime/centrifugo.publisher.js";
import { createObserver } from "../realtime/observer.js";
import { BudgetState, createCrewRuntime } from "./runtime.js";

@Injectable()
export class CrewRuntime implements OnModuleInit {
  private readonly runtime = createCrewRuntime();
  readonly state = new BudgetState();

  constructor(@Inject(InferenceService) private readonly inference: InferenceService,
    @Inject(CentrifugoPublisher) private readonly publisher: CentrifugoPublisher) {}

  onModuleInit(): void {
    this.runtime.initializeRuntime({ state: this.state, inferenceRunnerConfig: this.inference.config });
    this.join(createObserver(this.publisher, (id) => this.state.getParticipant(id)?.getManifest().name));
  }

  join(participant: Participant): void {
    this.runtime.join(participant);
  }

  sendEvent(event: SemanticEvent, senderId: string): void {
    this.runtime.sendEvent(event, senderId);
  }

  startLoop(agent: Agent, requestId: string, message: string,
    schema: StructuredOutputFormat, tools: Tool[] = agent.getTools(), model = "gpt-6-luna"): void {
    const context = ModelContext.create();
    context.addContextItem(DeveloperMessageItem.create(agent.getDeveloperMessage()));
    const start = () => this.runtime.runLoop(agent.getId(), `[req:${requestId}] ${message}`, {
      model, context, structuredOutput: schema, tools,
    });
    if (this.inference.mode === "live") {
      start();
      return;
    }
    // Core 6 constructs the cloud client synchronously inside runLoop. Empty (not
    // undefined) also overrides .env and cached credentials. Restore before returning.
    const key = process.env.MOZAIK_API_KEY;
    process.env.MOZAIK_API_KEY = "";
    try { start(); } finally {
      if (key === undefined) delete process.env.MOZAIK_API_KEY;
      else process.env.MOZAIK_API_KEY = key;
    }
  }
}
