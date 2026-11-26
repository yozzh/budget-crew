import { ModelContext, ModelMessageItem, UserMessageItem } from "@mozaik-ai/core";
import { ParsedExpense } from "@budget-crew/shared";
import { describe, expect, it } from "vitest";
import { StubInferenceRunner } from "./stub-inference.runner.js";

async function parse(name: string, text: string, runner = new StubInferenceRunner()) {
  const context = ModelContext.create();
  context.addContextItem(UserMessageItem.create(text));
  const output = await runner.run({
    model: "gpt-6-luna", context, structuredOutput: { name, schema: {} },
  });
  expect(output.items[0]).toBeInstanceOf(ModelMessageItem);
  return JSON.parse((output.items[0] as ModelMessageItem).content.text) as Record<string, unknown>;
}

describe("offline parser amounts", () => {
  it.each([
    ["coffee 3.50", 350],
    ["coffee 3.5", 350],
    ["coffee 3", 300],
    ["Кофе и круассан за 3,50 €", 350],
    ["[req:123456-99] Expense: coffee 3.50", 350],
    ["[req:123456-99] Expense: groceries €42.75", 4275],
    ["Expense: bus ticket €2", 200],
  ])("parses expense %s", async (text, amount) => {
    expect(await parse("ParsedExpense", text)).toMatchObject({ amount });
  });

  it("preserves euro expense categories and notes", async () => {
    expect(await parse("ParsedExpense", "[req:123] Expense: groceries €42.75"))
      .toEqual({ amount: 4275, category: "groceries", note: "groceries €42.75" });
  });

  it.each(["salary 2500", "[req:987654] Income: salary €2500.00"])("parses income %s", async (text) => {
    expect(await parse("ParsedIncome", text)).toEqual({ amount: 250000, kind: "salary", source: "Synthetic employer" });
  });

  it("parses bare extra income", async () => {
    expect(await parse("ParsedIncome", "[req:987] freelance 125.50"))
      .toEqual({ amount: 12550, kind: "extra", source: "freelance work" });
  });

  it.each(["Can I buy a jacket for 90?", "[req:987654] Can I buy a jacket for €90.00?"])("parses purchase %s", async (text) => {
    expect(await parse("ParsedPurchase", text)).toEqual({ item: "jacket", price: 9000, category: "electronics" });
  });

  it("does not replace a present amount with the purchase fixture", async () => {
    expect(await parse("ParsedPurchase", "jacket 90")).toEqual({ item: "jacket", price: 9000, category: "electronics" });
  });

  it.each([
    ["ParsedExpense", { amount: 350, category: "food", note: "coffee" }],
    ["ParsedIncome", { amount: 250000, kind: "salary", source: "salary" }],
    ["ParsedPurchase", { item: "AirPods", price: 18000, category: "electronics" }],
  ])("uses %s fixture only without an amount, ignoring request digits", async (name, expected) => {
    expect(await parse(name, "[req:123456-987] no monetary amount")).toEqual(expected);
  });

  it("preserves explicitly registered parser fixtures even with an amount", async () => {
    const runner = new StubInferenceRunner();
    const fixture = { amount: 123, category: "food", note: "custom" };
    runner.registerFixture("ParsedExpense", ParsedExpense, fixture);
    expect(await parse("ParsedExpense", "coffee 99", runner)).toEqual(fixture);
  });
});
