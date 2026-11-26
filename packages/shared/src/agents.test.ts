import { describe, expect, it } from "vitest";
import {
  AgentName, Judgement, ParsedExpense, ParsedIncome, ParsedPurchase, Verdict,
  VerdictSlot, agentOutputJsonSchemas,
} from "./index.js";

function expectStrictObjects(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(expectStrictObjects);
    return;
  }
  const node = value as Record<string, unknown>;
  if (node.type === "object") {
    expect(node.additionalProperties).toBe(false);
    const keys = Object.keys(node.properties as Record<string, unknown>);
    expect(node.required).toBeInstanceOf(Array);
    expect([...(node.required as string[])].sort()).toEqual(keys.sort());
  }
  Object.values(node).forEach(expectStrictObjects);
}

const expense = { amount: 1200, category: "food", note: "Lunch" };
const purchase = { item: "Headphones", price: 9900, category: "electronics" };
const income = { amount: 250000, kind: "salary", source: "Employer" };
const verdict = { level: "warn", headline: "Wait", reason: "Allowance would fall", figures: [] };
const judgement = { decision: "wait", why: "Save first", figures: [] };

it("generates five strict object JSON schemas, including nested array items", () => {
  expect(Object.keys(agentOutputJsonSchemas)).toEqual([
    "ParsedExpense", "ParsedPurchase", "ParsedIncome", "Verdict", "Judgement",
  ]);
  for (const schema of Object.values(agentOutputJsonSchemas)) {
    expect(schema.type).toBe("object");
    expectStrictObjects(schema);
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  }
});

describe("agent structured outputs", () => {
  it.each([
    [ParsedExpense, expense], [ParsedPurchase, purchase], [ParsedIncome, income],
    [Verdict, verdict], [Judgement, judgement],
  ] as const)("accepts a complete output and rejects undeclared fields", (schema, value) => {
    expect(schema.safeParse(value).success).toBe(true);
    expect(schema.safeParse({ ...value, extra: true }).success).toBe(false);
    for (const key of Object.keys(value)) {
      const incomplete: Record<string, unknown> = { ...value };
      delete incomplete[key];
      expect(schema.safeParse(incomplete).success).toBe(false);
    }
  });

  it("requires figures but accepts an empty array or complete string-valued figures", () => {
    for (const [schema, value] of [[Verdict, verdict], [Judgement, judgement]] as const) {
      expect(schema.safeParse(value).success).toBe(true);
      expect(schema.safeParse({ ...value, figures: [{ label: "Tomorrow", value: "€12" }] }).success).toBe(true);
      expect(schema.safeParse({ ...value, figures: [{ label: "Tomorrow", value: 12 }] }).success).toBe(false);
      expect(schema.safeParse({ ...value, figures: [{ label: "Tomorrow", value: "€12", raw: 12 }] }).success).toBe(false);
    }
  });

  it("validates monetary cents, output discriminants and text limits", () => {
    expect(ParsedExpense.safeParse({ ...expense, amount: 1.5 }).success).toBe(false);
    expect(ParsedPurchase.safeParse({ ...purchase, price: -1 }).success).toBe(false);
    expect(ParsedIncome.safeParse({ ...income, kind: "bonus" }).success).toBe(false);
    expect(Verdict.safeParse({ ...verdict, level: "maybe" }).success).toBe(false);
    expect(Judgement.safeParse({ ...judgement, decision: "approve" }).success).toBe(false);
    expect(Verdict.safeParse({ ...verdict, headline: "x".repeat(80), reason: "x".repeat(280) }).success).toBe(true);
    expect(Verdict.safeParse({ ...verdict, headline: "x".repeat(81) }).success).toBe(false);
    expect(Verdict.safeParse({ ...verdict, reason: "x".repeat(281) }).success).toBe(false);
  });
});

it("enumerates only the architecture's agent names", () => {
  expect(AgentName.options).toEqual([
    "Parser", "Planner", "Pace", "Anomaly", "Coach", "Impact", "Obligations", "Deal Check", "Alternatives", "Judge",
  ]);
  expect(AgentName.safeParse("Ledger").success).toBe(false);
  expect(AgentName.safeParse("DealCheck").success).toBe(false);
});

it("keeps failed verdict slots distinct from successful verdicts", () => {
  expect(VerdictSlot.safeParse(verdict).success).toBe(true);
  expect(VerdictSlot.parse({ status: "failed", error: "Timed out" })).toEqual({ status: "failed", error: "Timed out" });
  expect(VerdictSlot.safeParse({ status: "failed" }).success).toBe(false);
  expect(VerdictSlot.safeParse({ status: "ok", error: "Timed out" }).success).toBe(false);
  expect(VerdictSlot.safeParse({ ...verdict, status: "failed", error: "Timed out" }).success).toBe(false);
});
