import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { simulateBudget, upcomingObligations } from "@budget-crew/budget";
import type { Tool } from "@mozaik-ai/core";
import { z } from "zod";
import type { BudgetStore } from "../budget/budget.store.js";

type FunctionTool = Extract<Tool, { type: "function" }>;
const simulationArgs = z.strictObject({ amount: z.int().nonnegative() });
const obligationsArgs = z.strictObject({ horizonDays: z.int().nonnegative() });
const historyArgs = z.strictObject({ item: z.string() });
const historySchema = z.array(z.strictObject({
  item: z.string(),
  history: z.array(z.strictObject({ date: z.iso.date(), price: z.int().nonnegative() })),
}));

/** Read-only ledger tools; synthetic price history is explicitly not a live market quote. */
export function createPurchaseTools(store: BudgetStore): {
  simulateBudget: FunctionTool;
  upcomingObligations: FunctionTool;
  priceHistory: FunctionTool;
} {
  const paths = [new URL("../../../../seed/price-history.json", import.meta.url), new URL("../../seed/price-history.json", import.meta.url)];
  const path = paths.find(url => existsSync(fileURLToPath(url)));
  if (!path) throw new Error("Synthetic price history seed not found");
  const histories = historySchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const openPeriod = () => {
    const period = store.state.periods.find(candidate => candidate.id === store.state.currentPeriodId && candidate.status === "open");
    if (!period) throw new Error("No open budget period");
    return period;
  };
  return {
    simulateBudget: {
      type: "function", name: "simulate_budget", strict: true,
      description: "Simulate a purchase in integer cents against today's open budget period without changing the ledger.",
      parameters: z.toJSONSchema(simulationArgs),
      invoke: async (args: unknown) => simulateBudget(openPeriod(), store.state.today, simulationArgs.parse(args)),
    },
    upcomingObligations: {
      type: "function", name: "upcoming_obligations", strict: true,
      description: "Read unpaid planned obligations within an inclusive calendar-day horizon; money is integer cents.",
      parameters: z.toJSONSchema(obligationsArgs),
      invoke: async (args: unknown) => upcomingObligations(openPeriod(), store.state.today, obligationsArgs.parse(args).horizonDays),
    },
    priceHistory: {
      type: "function", name: "price_history", strict: true,
      description: "Look up a synthetic 90-day Black Friday item price history in integer cents; not a live quote. Unknown items return unknown.",
      parameters: z.toJSONSchema(historyArgs),
      invoke: async (args: unknown) => {
        const { item } = historyArgs.parse(args);
        const found = histories.find(entry => entry.item.toLowerCase() === item.trim().toLowerCase());
        return found ? { status: "known", source: "synthetic", unit: "cents", item: found.item,
          history: found.history.map(point => ({ ...point })) } : { status: "unknown" };
      },
    },
  };
}
