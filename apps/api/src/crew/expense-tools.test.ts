import { describe, expect, it } from "vitest";
import { simulateBudget, upcomingObligations } from "@budget-crew/budget";
import { BudgetStore } from "../budget/budget.store.js";
import { createExpenseTools } from "./expense-tools.js";

function setup() {
  const store = new BudgetStore();
  store.reset("2026-11-10");
  const period = store.state.periods.find(candidate => candidate.id === store.state.currentPeriodId)!;
  return { store, period, tools: createExpenseTools(store) };
}

function expectEuro(actual: unknown, raw: number) {
  expect(actual).toMatch(/^-?€\d{1,3}(,\d{3})*\.\d{2}$/);
  expect(Math.round(Number((actual as string).replace(/[€,]/g, "")) * 100)).toBe(raw);
}

describe("expense tools", () => {
  it("formats every projection amount without changing the ledger", async () => {
    const { store, period, tools } = setup();
    const row = period.projection.find(day => day.date === store.state.today)!;
    Object.assign(row, { allowance: 123456, expense: 0, remaining: -1240, nextAllowance: 5691, finalBalance: -1 });
    const before = JSON.stringify(store.state);
    const result = await tools.budgetSnapshot.invoke({}) as { projection: Record<string, unknown> };
    expect(result).not.toHaveProperty("unit");
    expect(result.projection.date).toBe(row.date);
    for (const key of ["allowance", "expense", "remaining", "nextAllowance", "finalBalance"] as const) {
      expectEuro(result.projection[key], row[key]!);
    }
    expect(result.projection).toMatchObject({ allowance: "€1,234.56", expense: "€0.00", remaining: "-€12.40" });
    expect(JSON.stringify(store.state)).toBe(before);
  });

  it("formats category total and rounded average but preserves count", async () => {
    const { store, period, tools } = setup();
    period.expenses = [123456, 1, 0].map((amount, index) => ({
      id: `test-${index}`, date: store.state.today, amount, category: "test", note: "", source: "user",
    }));
    const before = JSON.stringify(store.state);
    const result = await tools.categoryStats.invoke({ category: "test" }) as { total: string; average: string; count: number };
    expectEuro(result.total, 123457);
    expectEuro(result.average, Math.round(123457 / 3));
    expect(result.count).toBe(3);
    expect(result).not.toHaveProperty("unit");
    expect(await tools.categoryStats.invoke({ category: "missing" })).toMatchObject({ total: "€0.00", average: "€0.00", count: 0 });
    expect(JSON.stringify(store.state)).toBe(before);
  });

  it("formats nested obligations and their total without changing state", async () => {
    const { store, period, tools } = setup();
    period.articles = [123456, 0].map((amount, index) => ({
      id: `test-${index}`, name: "planned", amount, dueDate: store.state.today, paid: false,
    }));
    const before = JSON.stringify(store.state);
    const raw = upcomingObligations(period, store.state.today, 30);
    const result = await tools.upcomingObligations.invoke({ horizonDays: 30 }) as {
      total: string; unpaid: { amount: string }[]; remaining: string; remainingAfterObligations: string;
    };
    expectEuro(result.total, raw.total);
    const remaining = simulateBudget(period, store.state.today, { amount: 0 }).remaining.before;
    expectEuro(result.remaining, remaining);
    expectEuro(result.remainingAfterObligations, remaining - raw.total);
    result.unpaid.forEach((article, index) => expectEuro(article.amount, raw.unpaid[index]!.amount));
    expect(JSON.stringify(store.state)).toBe(before);
    period.articles = [];
    const emptyRemaining = simulateBudget(period, store.state.today, { amount: 0 }).remaining.before;
    const empty = await tools.upcomingObligations.invoke({ horizonDays: 0 }) as { remainingAfterObligations: string };
    expect(empty).toMatchObject({ unpaid: [], total: "€0.00" });
    expectEuro(empty.remainingAfterObligations, emptyRemaining);
  });
});
