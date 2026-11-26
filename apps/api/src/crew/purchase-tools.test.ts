import { describe, expect, it } from "vitest";
import { simulateBudget, upcomingObligations } from "@budget-crew/budget";
import { BudgetStore } from "../budget/budget.store.js";
import { createPurchaseTools } from "./purchase-tools.js";

function setup() {
  const store = new BudgetStore();
  store.reset("2026-11-10");
  const period = store.state.periods.find(candidate => candidate.id === store.state.currentPeriodId)!;
  return { store, period, tools: createPurchaseTools(store) };
}

describe("purchase tools", () => {
  it("returns the exact deterministic simulation without changing state", async () => {
    const { store, period, tools } = setup();
    const before = JSON.stringify(store.state);
    expect(tools.simulateBudget.name).toBe("simulate_budget");
    expect(await tools.simulateBudget.invoke({ amount: 18000 })).toEqual(simulateBudget(period, store.state.today, { amount: 18000 }));
    expect(await tools.simulateBudget.invoke({ amount: 0 })).toEqual(simulateBudget(period, store.state.today, { amount: 0 }));
    expect(JSON.stringify(store.state)).toBe(before);
  });

  it("returns exact upcoming obligations without changing state", async () => {
    const { store, period, tools } = setup();
    const before = JSON.stringify(store.state);
    expect(tools.upcomingObligations.name).toBe("upcoming_obligations");
    expect(await tools.upcomingObligations.invoke({ horizonDays: 30 })).toEqual(upcomingObligations(period, store.state.today, 30));
    expect(await tools.upcomingObligations.invoke({ horizonDays: 0 })).toEqual(upcomingObligations(period, store.state.today, 0));
    expect(JSON.stringify(store.state)).toBe(before);
  });

  it("looks up synthetic ninety-day AirPods history and reports unknown items", async () => {
    const { tools } = setup();
    expect(tools.priceHistory.name).toBe("price_history");
    const result = await tools.priceHistory.invoke({ item: "AirPods" });
    expect(result).toMatchObject({ status: "known", source: "synthetic", unit: "cents", item: "AirPods" });
    const { history } = result as { history: { date: string; price: number }[] };
    expect(history).toHaveLength(90);
    expect(history[0]).toEqual({ date: "2026-08-29", price: 22000 });
    expect(history[89]).toEqual({ date: "2026-11-26", price: 18700 });
    expect(history.every(point => Number.isInteger(point.price) && point.price >= 0)).toBe(true);
    expect(await tools.priceHistory.invoke({ item: " airpods " })).toEqual(result);
    expect(await tools.priceHistory.invoke({ item: "unlisted gadget" })).toEqual({ status: "unknown" });
  });

  it("validates integer nonnegative monetary amounts and horizons", async () => {
    const { tools } = setup();
    for (const value of [-1, 0.5]) {
      await expect(tools.simulateBudget.invoke({ amount: value })).rejects.toThrow();
      await expect(tools.upcomingObligations.invoke({ horizonDays: value })).rejects.toThrow();
    }
  });

  it("uses the current open period and date after reset", async () => {
    const { store, tools } = setup();
    store.reset("2026-12-03");
    const period = store.state.periods.find(candidate => candidate.id === store.state.currentPeriodId)!;
    expect(await tools.simulateBudget.invoke({ amount: 18000 })).toEqual(simulateBudget(period, store.state.today, { amount: 18000 }));
    expect(await tools.upcomingObligations.invoke({ horizonDays: 30 })).toEqual(upcomingObligations(period, store.state.today, 30));
  });
});
