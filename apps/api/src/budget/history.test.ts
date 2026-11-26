import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { closePeriod } from "@budget-crew/budget";
import { StateResponse, Verdict, type BudgetStateSnapshot, type AgentName } from "@budget-crew/shared";
import { expect, it } from "vitest";
import { BudgetStore } from "./budget.store.js";

const historyUrl = new URL("../../../../seed/history.json", import.meta.url);
const committed = JSON.parse(readFileSync(historyUrl, "utf8")) as Pick<BudgetStateSnapshot, "periods" | "requests">;

it("regenerates the committed history with valid closed budgets and complete point-in-time answers", () => {
  const generated = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
    'import { generateHistory } from "./seed/generate-history.ts"; console.log(JSON.stringify([generateHistory(), generateHistory()]));',
  ], { cwd: new URL("../../../../", import.meta.url), encoding: "utf8" });
  expect(JSON.parse(generated)).toEqual([committed, committed]);
  expect(committed.periods.map(period => period.start)).toEqual([
    "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01",
  ]);
  for (const [index, period] of committed.periods.entries()) {
    expect(period.status).toBe("closed");
    expect(period.finalBalance).toBe(closePeriod(period, period.end).finalBalance);
    expect(period.carryover).toBe(index === 0 ? 0 : Math.min(0, committed.periods[index - 1]!.finalBalance!));
    for (const day of period.projection) {
      const count = period.expenses.filter(expense => expense.date === day.date).length;
      expect(count).toBeGreaterThanOrEqual(3);
      expect(count).toBeLessThanOrEqual(6);
    }
    for (const entry of [period.salary, ...period.extraIncomes, ...period.expenses]) {
      if (entry.requestId) {
        const request = committed.requests[entry.requestId]!;
        expect(request).toBeDefined();
        expect(request.date).toBe(entry.date);
        expect(request.parsed).toMatchObject({ amount: entry.amount });
      }
    }
  }
  expect(committed.periods[2]!.finalBalance).toBeLessThan(0);
  expect(committed.periods[4]!.finalBalance).toBeGreaterThan(0);
  expect(committed.periods[1]!.extraIncomes.some(income => income.kind === "extra")).toBe(true);

  const requests = Object.values(committed.requests);
  expect(requests.length).toBeGreaterThanOrEqual(25);
  const purchases = requests.filter(request => request.kind === "purchase");
  expect(purchases.length).toBeGreaterThanOrEqual(6);
  expect(purchases.length).toBeLessThanOrEqual(8);
  expect(new Set(purchases.map(request => request.judgement?.decision))).toEqual(new Set(["buy", "wait", "skip"]));
  for (const request of requests) {
    expect(request.createdAt < "2026-11-01T00:00:00.000Z").toBe(true);
    const agents: AgentName[] = request.kind === "purchase" ? ["Impact", "Obligations", "Deal Check", "Alternatives"]
      : request.kind === "expense" ? ["Pace", "Anomaly", "Coach"]
      : request.parsed && "kind" in request.parsed && request.parsed.kind === "salary" ? ["Planner", "Obligations"] : ["Pace", "Coach"];
    expect(Object.keys(request.verdicts).sort()).toEqual(agents.sort());
    for (const verdict of Object.values(request.verdicts)) Verdict.parse(verdict);
  }
});

it("restores independent history on both reset paths and keeps the full snapshot below 1 MB", () => {
  const store = new BudgetStore();
  store.reset("2026-11-26");
  const snapshot = StateResponse.parse(store.snapshot());
  expect(snapshot.periods.slice(0, 5)).toEqual(committed.periods);
  expect(snapshot.periods[5]).toMatchObject({ status: "open", start: "2026-11-01", carryover: 0 });
  expect(snapshot.requests).toEqual(committed.requests);
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(1_000_000);
  store.state.periods[0]!.expenses[0]!.amount = 0;
  store.state.requests = {};
  store.reset("2026-11-01", { openPeriod: false });
  expect(store.snapshot().periods).toEqual(committed.periods);
  expect(store.snapshot().requests).toEqual(committed.requests);
  expect(store.snapshot().currentPeriodId).toBeUndefined();
});
