import {
  Agent, DeveloperMessageItem, ModelContext,
  type Participant, type SemanticEvent, type StructuredOutputFormat, type Tool,
} from "@mozaik-ai/core";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { InferenceService } from "../inference/inference.module.js";
import { CentrifugoPublisher } from "../realtime/centrifugo.publisher.js";
import { createObserver } from "../realtime/observer.js";
import { createCrewRuntime } from "./runtime.js";
import { BudgetStore, type BudgetState } from "../budget/budget.store.js";

@Injectable()
export class CrewRuntime implements OnModuleInit {
  private readonly runtime = createCrewRuntime();
  readonly state: BudgetState;
  private readonly suppressedRequests = new Set<string>();

  constructor(@Inject(InferenceService) private readonly inference: InferenceService,
    @Inject(CentrifugoPublisher) private readonly publisher: CentrifugoPublisher,
    @Inject(BudgetStore) store: BudgetStore) {
    this.state = store.state;
  }

  onModuleInit(): void {
    this.runtime.initializeRuntime({ state: this.state, inferenceRunnerConfig: this.inference.config });
    this.join(createObserver({
      publish: (channel, envelope) => {
        if (envelope.data.requestId && this.suppressedRequests.has(envelope.data.requestId)) return;
        return this.publisher.publish(channel, envelope);
      },
    }, (id) => this.state.getParticipant(id)?.getManifest().name));
  }

  join(participant: Participant): void {
    this.runtime.join(participant);
  }

  sendEvent(event: SemanticEvent, senderId: string): void {
    this.runtime.sendEvent(event, senderId);
  }

  suppressRequests(requestIds: Iterable<string>): void {
    for (const requestId of requestIds) this.suppressedRequests.add(requestId);
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
