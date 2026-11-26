import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RequestState } from "@budget-crew/shared";
import type { Tool } from "@mozaik-ai/core";
import { z } from "zod";
import type { BudgetStore } from "../budget/budget.store.js";
import { formatMoneyFields } from "./money.js";
import { createUpcomingObligationsTool } from "./expense-tools.js";

type FunctionTool = Extract<Tool, { type: "function" }>;
const simulationArgs = z.strictObject({
  amount: z.string().regex(/^€\d{1,3}(,\d{3})*\.\d{2}$/),
});
const historyArgs = z.strictObject({ item: z.string() });
const historySchema = z.array(z.strictObject({
  item: z.string(),
  history: z.array(z.strictObject({ date: z.iso.date(), price: z.int().nonnegative() })),
}));

/** Bound to one request, never to the mutable current budget. */
export function createPurchaseSimulationTool(request: RequestState): FunctionTool {
  return {
    type: "function", name: "simulate_budget", strict: true,
    description: "Return this request's stored purchase simulation, the only source of budget figures. Pass the purchase price as amount; it does not change the stored simulation.",
    parameters: z.toJSONSchema(simulationArgs),
    invoke: async (args: unknown) => {
      simulationArgs.parse(args);
      if (!request.simulation) throw new Error("Purchase simulation unavailable");
      return formatMoneyFields(request.simulation);
    },
  };
}

/** Read-only ledger tools; synthetic price history is explicitly not a live market quote. */
export function createPurchaseTools(store: BudgetStore): {
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
    upcomingObligations: createUpcomingObligationsTool(() => ({ period: openPeriod(), today: store.state.today })),
    priceHistory: {
      type: "function", name: "price_history", strict: true,
      description: "Look up a synthetic 90-day Black Friday item price history in euros; not a live quote. Unknown items return unknown.",
      parameters: z.toJSONSchema(historyArgs),
      invoke: async (args: unknown) => {
        const { item } = historyArgs.parse(args);
        const found = histories.find(entry => entry.item.toLowerCase() === item.trim().toLowerCase());
        return found ? { status: "known", source: "synthetic", item: found.item,
          history: formatMoneyFields(found.history) } : { status: "unknown" };
      },
    },
  };
}
