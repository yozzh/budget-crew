import { randomInt, randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import {
  FunctionCallItem, ModelMessageItem, SemanticEvent,
  type InferenceInput, type InferenceOutput, type InferenceRunner,
} from "@mozaik-ai/core";
import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { ParsedExpense, ParsedIncome, Verdict } from "@budget-crew/shared";

type Fixture = { answer: string; functionCall?: { name: string; args: unknown } };

@Injectable()
export class StubInferenceRunner implements InferenceRunner {
  private readonly fixtures = new Map<string, Fixture>();

  constructor() {
    this.registerFixture("ParsedExpense", ParsedExpense, { amount: 350, category: "food", note: "coffee" });
    this.registerFixture("ParsedIncome", ParsedIncome, { amount: 250000, kind: "salary", source: "salary" });
    this.registerFixture("PlannerVerdict", Verdict, {
      level: "ok", headline: "Period plan reviewed",
      reason: "Stub planning uses the deterministic budget snapshot.", figures: [],
    }, { name: "budget_snapshot", args: {} });
    this.registerFixture("ObligationsVerdict", Verdict, {
      level: "ok", headline: "Upcoming obligations reviewed",
      reason: "Stub review uses unpaid obligations from the deterministic ledger.", figures: [],
    }, { name: "upcoming_obligations", args: { horizonDays: 30 } });
    this.registerFixture("PaceVerdict", Verdict, {
      level: "ok", headline: "Budget snapshot reviewed",
      reason: "Stub assessment using the deterministic budget snapshot; no monetary calculation is performed by the model.",
      figures: [],
    }, { name: "budget_snapshot", args: {} });
    this.registerFixture("AnomalyVerdict", Verdict, {
      level: "ok", headline: "Category history reviewed",
      reason: "Stub assessment uses all recorded food expenses in the open period, including the newest expense.",
      figures: [],
    }, { name: "category_stats", args: { category: "food" } });
    this.registerFixture("CoachVerdict", Verdict, {
      level: "ok", headline: "Keep tracking expenses",
      reason: "Stub coaching uses the deterministic budget snapshot. Review the ledger's figures when planning further spending.",
      figures: [],
    }, { name: "budget_snapshot", args: {} });
  }

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
