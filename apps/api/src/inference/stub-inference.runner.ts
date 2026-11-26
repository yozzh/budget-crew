import { randomInt, randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import {
  FunctionCallItem, ModelMessageItem, SemanticEvent, UserMessageItem,
  type InferenceInput, type InferenceOutput, type InferenceRunner,
} from "@mozaik-ai/core";
import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { Judgement, ParsedExpense, ParsedPurchase, Verdict } from "@budget-crew/shared";

type Fixture = { answer: string; functionCall?: { name: string; args: unknown } };

@Injectable()
export class StubInferenceRunner implements InferenceRunner {
  private readonly fixtures = new Map<string, Fixture>();

  constructor() {
    this.registerFixture("ParsedExpense", ParsedExpense, { amount: 350, category: "food", note: "coffee" });
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
    this.registerFixture("ParsedPurchase", ParsedPurchase, { item: "AirPods", price: 18000, category: "electronics" });
    for (const [name, headline, functionCall] of [
      ["ImpactVerdict", "Purchase impact reviewed", { name: "simulate_budget", args: { amount: 18000 } }],
      ["ObligationsVerdict", "Upcoming obligations reviewed", { name: "upcoming_obligations", args: { horizonDays: 30 } }],
      ["DealCheckVerdict", "Synthetic price history reviewed", { name: "price_history", args: { item: "AirPods" } }],
      ["AlternativesVerdict", "Consider waiting or comparing alternatives", undefined],
    ] as const) {
      this.registerFixture(name, Verdict, {
        level: "ok", headline,
        reason: "Stub assessment only. Consult deterministic tool results; no live market prices or model calculations are used.",
        figures: [],
      }, functionCall);
    }
    this.registerFixture("Judgement", Judgement, {
      decision: "wait", why: "Stub judgement: review the deterministic purchase simulation before buying.", figures: [],
    }, { name: "simulate_budget", args: { amount: 18000 } });
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
    // Purchase flows send their parsed purchase in the current user message.
    // Keep registered fixtures unchanged; only the invocation's arguments vary.
    let purchase: ParsedPurchase | undefined;
    for (const item of [...input.context.items].reverse()) {
      if (!(item instanceof UserMessageItem)) continue;
      const text = item.content.text;
      const start = text.indexOf("{");
      if (start < 0) break;
      try {
        const context = JSON.parse(text.slice(start)) as unknown;
        const candidate = ParsedPurchase.safeParse(context);
        const nested = typeof context === "object" && context !== null && "purchase" in context
          ? ParsedPurchase.safeParse(context.purchase) : undefined;
        purchase = candidate.success ? candidate.data : nested?.success ? nested.data : undefined;
      } catch { /* A free-text parser request has no parsed purchase yet. */ }
      break;
    }
    const call = fixture.functionCall;
    if (call && !input.context.items.some((item) => item.type === "function_call")) {
      if (!input.tools?.some((tool) => tool.name === call.name)) {
        throw new Error(`Stub fixture requests unavailable tool: ${call.name}`);
      }
      return {
        items: [FunctionCallItem.rehydrate({ callId: randomUUID(), name: call.name, args: JSON.stringify(
          purchase && call.name === "simulate_budget" ? { amount: purchase.price }
            : purchase && call.name === "price_history" ? { item: purchase.item } : call.args,
        ) })],
        tokenUsage: undefined, rowResponse: undefined,
      };
    }
    return { items: [ModelMessageItem.rehydrate({ text: fixture.answer })], tokenUsage: undefined, rowResponse: undefined };
  }

  async *stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
    yield SemanticEvent.create("inference.output", "stub", await this.run(input));
  }
}
