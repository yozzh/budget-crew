import { randomInt, randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import {
  FunctionCallItem, ModelMessageItem, SemanticEvent,
  type InferenceInput, type InferenceOutput, type InferenceRunner,
} from "@mozaik-ai/core";
import { Injectable } from "@nestjs/common";
import { z } from "zod";

type Fixture = { answer: string; functionCall?: { name: string; args: unknown } };

@Injectable()
export class StubInferenceRunner implements InferenceRunner {
  private readonly fixtures = new Map<string, Fixture>();

  registerFixture(name: string, schema: z.ZodType, value: unknown,
    functionCall?: Fixture["functionCall"]): void {
    this.fixtures.set(name, { answer: JSON.stringify(schema.parse(value)), functionCall });
  }

  async run(input: InferenceInput): Promise<InferenceOutput> {
    const name = input.structuredOutput?.name;
    const fixture = name ? this.fixtures.get(name) : undefined;
    if (!fixture) throw new Error(`No stub fixture for schema: ${name ?? "unnamed"}`);
    await setTimeout(randomInt(50, 401));
    const call = fixture.functionCall;
    if (call && !input.context.items.some((item) => item.type === "function_call")) {
      if (!input.tools?.some((tool) => tool.name === call.name)) {
        throw new Error(`Stub fixture requests unavailable tool: ${call.name}`);
      }
      return {
        items: [FunctionCallItem.rehydrate({ callId: randomUUID(), name: call.name, args: JSON.stringify(call.args) })],
        tokenUsage: undefined, rowResponse: undefined,
      };
    }
    return { items: [ModelMessageItem.rehydrate({ text: fixture.answer })], tokenUsage: undefined, rowResponse: undefined };
  }

  async *stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
    yield SemanticEvent.create("inference.output", "stub", await this.run(input));
  }
}
