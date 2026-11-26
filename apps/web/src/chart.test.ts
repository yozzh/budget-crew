import { describe, expect, it } from "vitest";
import type { Period } from "@budget-crew/shared";
import { allowanceChartData } from "./chart.js";

function period(): Period {
  return {
    id: "salary", status: "open", start: "2026-11-01", end: "2026-11-03",
    salary: { id: "salary", date: "2026-11-01", amount: 10000, source: "Demo", kind: "salary" },
    carryover: 1000,
    articles: [{ id: "rent", name: "Rent", amount: 2000, dueDate: "2026-11-02", paid: false }],
    expenses: [], extraIncomes: [],
    projection: [
      { date: "2026-11-01", allowance: 3000, expense: 0, remaining: 9000, nextAllowance: 3000 },
      { date: "2026-11-02", allowance: 3000, expense: 0, remaining: 9000, nextAllowance: 3000 },
      { date: "2026-11-03", allowance: 3000, expense: 0, remaining: 9000, finalBalance: 9000 },
    ],
  };
}

describe("allowance chart data", () => {
  it("shows the full period in euros, reserving planned articles and carryover", () => {
    const before = period();
    expect(allowanceChartData(before)).toEqual([
      { date: "2026-11-01", planned: 30, actual: 30 },
      { date: "2026-11-02", planned: 30, actual: 30 },
      { date: "2026-11-03", planned: 30, actual: 30 },
    ]);
    expect(before).toEqual(period());
  });

  it("uses the server's redistributed future allowances without moving the baseline", () => {
    const after = period();
    after.expenses = [{ id: "food", date: "2026-11-01", amount: 2000, category: "food", note: "Groceries", source: "sim" }];
    after.projection = [
      { date: "2026-11-01", allowance: 3000, expense: 2000, remaining: 7000, nextAllowance: 3500 },
      { date: "2026-11-02", allowance: 3500, expense: 0, remaining: 7000, nextAllowance: 3500 },
      { date: "2026-11-03", allowance: 3500, expense: 0, remaining: 7000, finalBalance: 7000 },
    ];
    expect(allowanceChartData(after)).toEqual([
      { date: "2026-11-01", planned: 30, actual: 30 },
      { date: "2026-11-02", planned: 30, actual: 35 },
      { date: "2026-11-03", planned: 30, actual: 35 },
    ]);
  });

  it("reflects extra income in actual projection only, including future days", () => {
    const after = period();
    after.extraIncomes = [{ id: "side", date: "2026-11-02", amount: 1500, source: "Side job", kind: "extra" }];
    after.projection[1] = { date: "2026-11-02", allowance: 3750, expense: 0, remaining: 10500, nextAllowance: 3750 };
    after.projection[2] = { date: "2026-11-03", allowance: 3750, expense: 0, remaining: 10500, finalBalance: 10500 };
    expect(allowanceChartData(after).map(({ planned, actual }) => [planned, actual])).toEqual([[30, 30], [30, 37.5], [30, 37.5]]);
  });

  it("rounds the original baseline to cents and preserves negative actual allowances", () => {
    const after = period();
    after.salary.amount = 10001;
    after.projection[2]!.allowance = -125;
    expect(allowanceChartData(after)[2]).toEqual({ date: "2026-11-03", planned: 30, actual: -1.25 });
  });

  it("has no stale chart without an open period", () => {
    expect(allowanceChartData(undefined)).toEqual([]);
    expect(allowanceChartData({ ...period(), status: "closed" })).toEqual([]);
  });
});
