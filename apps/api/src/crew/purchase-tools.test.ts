import { readFileSync } from "node:fs";
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

function expectMoney(actual: unknown, raw: unknown, key = ""): void {
  if (typeof raw === "number") {
    if (key === "daysLeft") { expect(actual).toBe(raw); return; }
    expect(actual).toMatch(/^-?€\d{1,3}(,\d{3})*\.\d{2}$/);
    expect(Math.round(Number((actual as string).replace(/[€,]/g, "")) * 100)).toBe(raw);
  } else if (raw !== null && typeof raw === "object") {
    expect(Object.keys(actual as object)).toEqual(Object.keys(raw));
    for (const [name, value] of Object.entries(raw)) {
      expectMoney((actual as Record<string, unknown>)[name], value, name);
    }
  } else expect(actual).toBe(raw);
}

describe("purchase tools", () => {
  it("returns the exact deterministic simulation without changing state", async () => {
    const { store, period, tools } = setup();
    const before = JSON.stringify(store.state);
    expect(tools.simulateBudget.name).toBe("simulate_budget");
    for (const [amount, display] of [[18000, "€180.00"], [0, "€0.00"], [123456, "€1,234.56"]] as const) {
      expectMoney(await tools.simulateBudget.invoke({ amount: display }), simulateBudget(period, store.state.today, { amount }));
    }
    expect(JSON.stringify(store.state)).toBe(before);
  });

  it("returns exact upcoming obligations without changing state", async () => {
    const { store, period, tools } = setup();
    const before = JSON.stringify(store.state);
    expect(tools.upcomingObligations.name).toBe("upcoming_obligations");
    expectMoney(await tools.upcomingObligations.invoke({ horizonDays: 30 }), upcomingObligations(period, store.state.today, 30));
    expectMoney(await tools.upcomingObligations.invoke({ horizonDays: 0 }), upcomingObligations(period, store.state.today, 0));
    expect(JSON.stringify(store.state)).toBe(before);
  });

  it("looks up synthetic ninety-day AirPods history and reports unknown items", async () => {
    const { tools } = setup();
    expect(tools.priceHistory.name).toBe("price_history");
    const result = await tools.priceHistory.invoke({ item: "AirPods" });
    expect(result).toMatchObject({ status: "known", source: "synthetic", item: "AirPods" });
    expect(result).not.toHaveProperty("unit");
    const { history } = result as { history: { date: string; price: string }[] };
    expect(history).toHaveLength(90);
    expect(history[0]).toEqual({ date: "2026-08-29", price: "€220.00" });
    expect(history[89]).toEqual({ date: "2026-11-26", price: "€187.00" });
    expect(history.every(point => /^€\d{1,3}(,\d{3})*\.\d{2}$/.test(point.price))).toBe(true);
    const seed = JSON.parse(readFileSync(new URL("../../../../seed/price-history.json", import.meta.url), "utf8")) as {
      item: string; history: { date: string; price: number }[];
    }[];
    expectMoney(history, seed.find(entry => entry.item === "AirPods")!.history);
    expect(await tools.priceHistory.invoke({ item: " airpods " })).toEqual(result);
    expect(await tools.priceHistory.invoke({ item: "unlisted gadget" })).toEqual({ status: "unknown" });
  });

  it("rejects numeric, negative and malformed purchase prices and invalid horizons", async () => {
    const { tools } = setup();
    for (const amount of [18000, 0, -1, 0.5, "-€1.00", "€180", "€1,23.45", "€1234.56"]) {
      await expect(tools.simulateBudget.invoke({ amount })).rejects.toThrow();
    }
    for (const horizonDays of [-1, 0.5]) {
      await expect(tools.upcomingObligations.invoke({ horizonDays })).rejects.toThrow();
    }
  });

  it("uses the current open period and date after reset", async () => {
    const { store, tools } = setup();
    store.reset("2026-12-03");
    const period = store.state.periods.find(candidate => candidate.id === store.state.currentPeriodId)!;
    expectMoney(await tools.simulateBudget.invoke({ amount: "€180.00" }), simulateBudget(period, store.state.today, { amount: 18000 }));
    expectMoney(await tools.upcomingObligations.invoke({ horizonDays: 30 }), upcomingObligations(period, store.state.today, 30));
  });
});
