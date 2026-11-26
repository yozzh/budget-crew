import type { Tool } from "@mozaik-ai/core";
import { z } from "zod";
import { simulateBudget, upcomingObligations, type ISODate, type Period } from "@budget-crew/budget";
import type { BudgetStore } from "../budget/budget.store.js";
import { formatEuros, formatMoneyFields } from "./money.js";

type FunctionTool = Extract<Tool, { type: "function" }>;
const noArgs = z.strictObject({});
const categoryArgs = z.strictObject({ category: z.string() });
const obligationsArgs = z.strictObject({ horizonDays: z.int().nonnegative() });

/** One implementation for live period reviews and submission-bound purchase reviews. */
export function createUpcomingObligationsTool(context: () => { period: Period; today: ISODate }): FunctionTool {
  return {
    type: "function", name: "upcoming_obligations", strict: true,
    description: "Read unpaid obligations through horizonDays inclusive, remaining budget and remainingAfterObligations. Planned obligations are already reserved; subtracting them again is a conservative coverage check. Money is in euros.",
    parameters: z.toJSONSchema(obligationsArgs),
    invoke: async (args: unknown) => {
      const { horizonDays } = obligationsArgs.parse(args);
      const { period, today } = context();
      const obligations = upcomingObligations(period, today, horizonDays);
      const remaining = simulateBudget(period, today, { amount: 0 }).remaining.before;
      return formatMoneyFields({ ...obligations, remaining, remainingAfterObligations: remaining - obligations.total });
    },
  };
}

/** Read-only tools: monetary values are formatted only at the LLM boundary. */
export function createExpenseTools(store: BudgetStore): {
  budgetSnapshot: FunctionTool;
  categoryStats: FunctionTool;
  upcomingObligations: FunctionTool;
} {
  const openPeriod = () => {
    const period = store.state.periods.find(
      candidate => candidate.id === store.state.currentPeriodId && candidate.status === "open",
    );
    if (!period) throw new Error("No open budget period");
    return period;
  };

  return {
    upcomingObligations: createUpcomingObligationsTool(() => ({ period: openPeriod(), today: store.state.today })),
    budgetSnapshot: {
      type: "function",
      name: "budget_snapshot",
      description: "Read today's deterministic budget projection for the open period. Money is formatted in euros.",
      parameters: z.toJSONSchema(noArgs),
      strict: true,
      invoke: async (args: unknown) => {
        noArgs.parse(args);
        const period = openPeriod();
        const projection = period.projection.find(row => row.date === store.state.today);
        if (!projection) throw new Error("No budget projection for today");
        return { periodId: period.id, today: store.state.today, currency: store.state.profile.currency,
          projection: formatMoneyFields(projection) };
      },
    },
    categoryStats: {
      type: "function",
      name: "category_stats",
      description: "Read category statistics for all recorded expenses in the open period, including the newest expense. Total and rounded average are formatted in euros; no expense is excluded.",
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
          includesNewest: true, count, total: formatEuros(total), average: formatEuros(count === 0 ? 0 : Math.round(total / count)) };
      },
    },
  };
}
