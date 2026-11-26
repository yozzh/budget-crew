import {
  UserMessageItem, type InferenceInput, type InferenceOutput, type InferenceRunner, type SemanticEvent,
} from "@mozaik-ai/core";

export class RoutingInferenceRunner implements InferenceRunner {
  constructor(private readonly requestMode: (requestId: string) => "live" | "stub",
    private readonly live: InferenceRunner, private readonly stub: InferenceRunner) {}

  private runner(input: InferenceInput): InferenceRunner {
    // Tool rounds may append user messages. Only the initial user message owns the route.
    const first = input.context.items.find((item) => item instanceof UserMessageItem);
    const requestId = first instanceof UserMessageItem
      ? /^\[req:([^\]\r\n]+)\]/.exec(first.content.text)?.[1] : undefined;
    return requestId !== undefined && this.requestMode(requestId) === "live" ? this.live : this.stub;
  }

  run(input: InferenceInput): Promise<InferenceOutput> {
    return this.runner(input).run(input);
  }

  stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
    return this.runner(input).stream(input);
  }
}
