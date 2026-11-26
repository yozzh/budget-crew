import type { Tool } from "@mozaik-ai/core";
import { z } from "zod";
import type { BudgetStore } from "../budget/budget.store.js";

type FunctionTool = Extract<Tool, { type: "function" }>;
const noArgs = z.strictObject({});
const categoryArgs = z.strictObject({ category: z.string() });

/** Read-only tools: all monetary values come from the deterministic ledger, in cents. */
export function createExpenseTools(store: BudgetStore): {
  budgetSnapshot: FunctionTool;
  categoryStats: FunctionTool;
} {
  const openPeriod = () => {
    const period = store.state.periods.find(
      candidate => candidate.id === store.state.currentPeriodId && candidate.status === "open",
    );
    if (!period) throw new Error("No open budget period");
    return period;
  };

  return {
    budgetSnapshot: {
      type: "function",
      name: "budget_snapshot",
      description: "Read today's deterministic budget projection for the open period. All monetary values are integer cents.",
      parameters: z.toJSONSchema(noArgs),
      strict: true,
      invoke: async (args: unknown) => {
        noArgs.parse(args);
        const period = openPeriod();
        const projection = period.projection.find(row => row.date === store.state.today);
        if (!projection) throw new Error("No budget projection for today");
        return { periodId: period.id, today: store.state.today, currency: store.state.profile.currency,
          unit: "cents", projection: { ...projection } };
      },
    },
    categoryStats: {
      type: "function",
      name: "category_stats",
      description: "Read category statistics for all recorded expenses in the open period, including the newest expense. Total and rounded average are integer cents; no expense is excluded.",
      parameters: z.toJSONSchema(categoryArgs),
      strict: true,
      invoke: async (args: unknown) => {
        const { category } = categoryArgs.parse(args);
        const period = openPeriod();
        let count = 0;
        let total = 0;
        for (const expense of period.expenses) {
          if (expense.category !== category) continue;
          count += 1;
          total += expense.amount;
        }
        return { periodId: period.id, category, scope: "all_recorded_open_period_expenses",
          includesNewest: true, unit: "cents", count, total, average: count === 0 ? 0 : Math.round(total / count) };
      },
    },
  };
}
