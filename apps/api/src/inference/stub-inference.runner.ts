import { randomInt, randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import {
  FunctionCallItem, ModelMessageItem, SemanticEvent, UserMessageItem,
  type InferenceInput, type InferenceOutput, type InferenceRunner,
} from "@mozaik-ai/core";
import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { Judgement, ParsedExpense, ParsedIncome, ParsedPurchase, Verdict } from "@budget-crew/shared";
import { stubWebSearchResult } from "../crew/web-search.js";

type FixtureCall = { name: string; args: unknown };
type Fixture = { answer: string; functionCalls: readonly FixtureCall[] };
const DisplayPurchase = z.object({
  item: z.string(),
  price: z.string().regex(/^€\d{1,3}(?:,\d{3})*\.\d{2}$/),
});

@Injectable()
export class StubInferenceRunner implements InferenceRunner {
  private readonly fixtures = new Map<string, Fixture>();
  private readonly parserDefaults = new Map<string, Fixture>();

  constructor() {
    const source = stubWebSearchResult.sources[0];
    const sourceFigure = {
      label: "Source",
      value: `${new URL(source.url).hostname} ${source.title.match(/EUR \d+\.\d{2}/)![0].replace("EUR ", "€")}`,
    };
    this.registerFixture("ParsedExpense", ParsedExpense, { amount: 350, category: "food", note: "coffee" });
    this.registerFixture("ParsedIncome", ParsedIncome, { amount: 250000, kind: "salary", source: "salary" });
    this.registerFixture("PlannerVerdict", Verdict, {
      level: "ok", headline: "Period plan reviewed",
      reason: "Stub planning uses the deterministic budget snapshot.", figures: [],
    }, { name: "budget_snapshot", args: {} });
    this.registerFixture("ObligationsVerdict", Verdict, {
      level: "ok", headline: "Upcoming obligations reviewed",
      reason: "Stub review uses the supplied budget and conservative obligations coverage.", figures: [],
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
    this.registerFixture("ParsedPurchase", ParsedPurchase, { item: "AirPods", price: 18000, category: "electronics" });
    this.registerFixture("ImpactVerdict", Verdict, {
      level: "ok", headline: "Purchase impact reviewed",
      reason: "Stub assessment only. Consult deterministic tool results; no live market prices or model calculations are used.",
      figures: [],
    }, { name: "simulate_budget", args: { amount: "€180.00" } });
    this.registerFixture("DealCheckVerdict", Verdict, {
      level: "ok", headline: "Offline synthetic prices reviewed",
      reason: "Stub assessment uses synthetic history and an offline synthetic search fixture, not live market prices.",
      figures: [sourceFigure],
    }, [
      { name: "price_history", args: { item: "AirPods" } },
      { name: "web_search", args: { query: "AirPods current price EUR" } },
    ]);
    this.registerFixture("AlternativesVerdict", Verdict, {
      level: "warn", headline: "Compare a cheaper or deferred purchase",
      reason: "Stub review uses the stored simulation and an offline synthetic search fixture, not live alternative prices.",
      figures: [sourceFigure],
    }, { name: "web_search", args: { query: "AirPods cheaper alternatives EUR" } });
    this.registerFixture("Judgement", Judgement, {
      decision: "wait", why: "Stub judgement: review the deterministic purchase simulation before buying.", figures: [],
    }, { name: "simulate_budget", args: { amount: "€180.00" } });
    for (const name of ["ParsedExpense", "ParsedIncome", "ParsedPurchase"]) {
      this.parserDefaults.set(name, this.fixtures.get(name)!);
    }
  }

  registerFixture(name: string, schema: z.ZodType, value: unknown,
    functionCall?: FixtureCall | readonly FixtureCall[]): void {
    const functionCalls = functionCall === undefined ? [] : "name" in functionCall
      ? [functionCall] : functionCall;
    this.fixtures.set(name, { answer: JSON.stringify(schema.parse(value)), functionCalls });
  }

  async run(input: InferenceInput): Promise<InferenceOutput> {
    const name = input.structuredOutput?.name;
    const fixture = name ? this.fixtures.get(name) : undefined;
    if (!fixture) throw new Error(`No stub fixture for schema: ${name ?? "unnamed"}`);
    await setTimeout(randomInt(50, 401));
    // Purchase flows send their parsed purchase in the current user message.
    // Keep registered fixtures unchanged; only the invocation's arguments vary.
    let purchase: z.infer<typeof DisplayPurchase> | undefined;
    let parserText = "";
    for (const item of [...input.context.items].reverse()) {
      if (!(item instanceof UserMessageItem)) continue;
      const text = item.content.text;
      parserText = text;
      const start = text.indexOf("{");
      if (start < 0) break;
      try {
        const context = JSON.parse(text.slice(start)) as unknown;
        const candidate = DisplayPurchase.safeParse(context);
        const nested = typeof context === "object" && context !== null && "purchase" in context
          ? DisplayPurchase.safeParse(context.purchase) : undefined;
        purchase = candidate.success ? candidate.data : nested?.success ? nested.data : undefined;
      } catch { /* A free-text parser request has no parsed purchase yet. */ }
      break;
    }
    const callIndex = input.context.items.reduce((count, item) => count + (item.type === "function_call" ? 1 : 0), 0);
    const call = fixture.functionCalls[callIndex];
    if (call) {
      if (!input.tools?.some((tool) => tool.name === call.name)) {
        throw new Error(`Stub fixture requests unavailable tool: ${call.name}`);
      }
      return {
        items: [FunctionCallItem.rehydrate({ callId: randomUUID(), name: call.name, args: JSON.stringify(
          purchase && call.name === "simulate_budget" ? { amount: purchase.price }
            : purchase && call.name === "price_history" ? { item: purchase.item }
            : purchase && call.name === "web_search"
              ? { query: `${purchase.item} ${name === "AlternativesVerdict" ? "cheaper alternatives" : "current price"} EUR` }
              : call.args,
        ) })],
        tokenUsage: undefined, rowResponse: undefined,
      };
    }
    const parsed = name && this.parserDefaults.get(name) === fixture ? this.parseText(name, parserText) : undefined;
    return { items: [ModelMessageItem.rehydrate({ text: parsed === undefined ? fixture.answer : JSON.stringify(parsed) })], tokenUsage: undefined, rowResponse: undefined };
  }

  /** Deliberately small offline grammar for the synthetic free-text month, not an LLM substitute. */
  private parseText(name: string, text: string): unknown {
    text = text.replace(/\[req:[^\]]*\]/g, "").trim();
    const money = /€(\d+)(?:[.,](\d{1,2}))?/.exec(text)
      ?? /\b(\d+)(?:[.,](\d{1,2}))?\b/.exec(text);
    if (!money) return undefined;
    const amount = Number(money[1]) * 100 + Number((money[2] ?? "").padEnd(2, "0"));
    if (name === "ParsedExpense") {
      const category = /groceries/i.test(text) ? "groceries" : /bus ticket/i.test(text) ? "transport"
        : /cinema/i.test(text) ? "entertainment" : "food";
      return ParsedExpense.parse({ amount, category, note: text.replace(/^[\s\S]*?Expense:\s*/, "") });
    }
    if (name === "ParsedIncome") {
      const salary = /salary/i.test(text);
      return ParsedIncome.parse({ amount, kind: salary ? "salary" : "extra",
        source: salary ? "Synthetic employer" : "freelance work" });
    }
    if (name === "ParsedPurchase") {
      const item = /Can I buy (?:an? )?(.+?) for\s+€?\d/i.exec(text)?.[1]
        ?? (text.slice(0, money.index).replace(/^Purchase:\s*/i, "").trim()
          || text.slice(money.index + money[0].length).replace(/[?!.]+$/, "").trim()
          || "purchase");
      return ParsedPurchase.parse({ item, price: amount, category: "electronics" });
    }
    return undefined;
  }

  async *stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
    yield SemanticEvent.create("inference.output", "stub", await this.run(input));
  }
}
