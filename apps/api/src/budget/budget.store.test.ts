import { describe, expect, it } from "vitest";
import { closePeriod, projectDaily, type Expense, type Income, type ISODate } from "@budget-crew/budget";
import { StateResponse } from "@budget-crew/shared";
import { BudgetStore } from "./budget.store.js";

function storeAt(date: ISODate = "2026-11-26") {
  const store = new BudgetStore();
  store.reset(date);
  return store;
}
const expense: Expense = { id: "expense", requestId: "req", date: "2026-11-26", amount: 1234, category: "food", note: "Lunch", source: "user" };
const salary: Income = { id: "salary", requestId: "salary-req", date: "2026-11-27", amount: 250000, kind: "salary", source: "Employer" };

describe("BudgetStore", () => {
  it("closes an early salary period and carries the final balance into the next", () => {
    const store = storeAt();
    store.recordExpense(expense);
    const current = store.snapshot().periods.find(period => period.id === store.state.currentPeriodId)!;
    const expected = closePeriod(current, "2026-11-26");
    store.recordIncome(salary);
    const state = store.snapshot();
    expect(state.periods.find(period => period.id === current.id)).toEqual(expected.period);
    expect(state.periods.find(period => period.id === state.currentPeriodId)!.carryover).toBe(expected.finalBalance);
    expect(state.currentPeriodId).toBe(salary.id);
    expect(state.periods.find(period => period.id === state.currentPeriodId)!.status).toBe("open");
  });

  it("recomputes expense allowance with projectDaily, including same-day expense totals", () => {
    const store = storeAt();
    store.recordExpense(expense);
    store.recordExpense({ ...expense, id: "second", amount: 500 });
    const period = store.snapshot().periods.find(period => period.id === store.state.currentPeriodId)!;
    const expensesByDate: Partial<Record<ISODate, number>> = {};
    for (const entry of period.expenses) expensesByDate[entry.date] = (expensesByDate[entry.date] ?? 0) + entry.amount;
    const expected = projectDaily({ dates: period.projection.map(day => day.date),
      residual: period.salary.amount - period.articles.reduce((sum, article) => sum + article.amount, 0),
      expensesByDate, today: "2026-11-26" });
    expect(period.projection).toEqual(expected);
    expect(period.projection.find(day => day.date === "2026-11-26")!.expense).toBe(1734);
  });

  it("retains independent verdict slots, including failures, and judgement", () => {
    const store = storeAt();
    store.beginRequest("purchase", "purchase", "Demo headphones");
    const verdict = { level: "ok" as const, headline: "Affordable", reason: "Within plan", figures: [] };
    store.putVerdict("purchase", "Impact", verdict);
    store.putVerdict("purchase", "Obligations", { status: "failed", error: "timeout" });
    store.putJudgement("purchase", { decision: "wait", why: "Missing obligations verdict", figures: [] });
    expect(store.snapshot().requests.purchase!.verdicts).toEqual({ Impact: verdict, Obligations: { status: "failed", error: "timeout" } });
    expect(store.snapshot().requests.purchase!.judgement!.decision).toBe("wait");
  });

  it("rejects expenses without an open period before creating a request", () => {
    const store = storeAt();
    const requests = store.snapshot().requests;
    store.state.periods = [];
    delete store.state.currentPeriodId;
    expect(() => store.recordExpense(expense)).toThrowError(expect.objectContaining({ response: { error: "no_open_period" } }));
    expect(store.snapshot().requests).toEqual(requests);
  });

  it("adds extra income to the open period without opening another", () => {
    const store = storeAt();
    const before = store.snapshot().periods.find(period => period.id === store.state.currentPeriodId)!.projection.find(day => day.date === "2026-11-26")!;
    store.recordIncome({ ...salary, id: "extra", date: "2026-11-26", kind: "extra", amount: 5000 });
    const state = store.snapshot();
    expect(state.periods).toHaveLength(6);
    const period = state.periods.find(period => period.id === state.currentPeriodId)!;
    expect(period.extraIncomes[0]!.amount).toBe(5000);
    expect(period.projection.find(day => day.date === "2026-11-26")!.remaining).toBe(before.remaining + 5000);
  });

  it("limits requests to 200, exposes the last 50 and isolates snapshots", () => {
    const store = storeAt();
    for (let index = 0; index < 205; index++) store.beginRequest(`req-${index}`, "purchase", "Demo");
    expect(Object.keys(store.snapshot().requests)).toHaveLength(200);
    expect(store.snapshot().requests["req-0"]).toBeUndefined();
    const snapshot = store.snapshot(50);
    expect(Object.keys(snapshot.requests)[0]).toBe("req-155");
    snapshot.periods.find(period => period.id === snapshot.currentPeriodId)!.expenses.length = 0;
    snapshot.profile.name = "Changed";
    expect(store.snapshot().profile.name).toBe("Alex");
    expect(store.snapshot().periods.find(period => period.id === store.state.currentPeriodId)!.expenses).toHaveLength(3);
  });

  it("resets in place and anchors the seed to the requested month", () => {
    const store = storeAt();
    const state = store.state;
    const participants = state.participants;
    store.recordExpense(expense);
    store.reset("2027-02-02");
    expect(store.state).toBe(state);
    expect(store.state.participants).toBe(participants);
    const snapshot = StateResponse.parse(store.snapshot(50));
    expect(snapshot.periods.filter(period => period.status === "open")).toHaveLength(1);
    const period = snapshot.periods.find(period => period.id === snapshot.currentPeriodId)!;
    expect(period.start).toBe("2027-02-01");
    expect(period.end).toBe("2027-02-28");
    expect(period.expenses).toHaveLength(2);
    expect(snapshot.requests).toEqual(storeAt("2027-02-02").snapshot(50).requests);
  });

  it("cancels only unfinished simulation work, preserving existing slots and recorded money", () => {
    const store = storeAt();
    const verdict = { level: "ok" as const, headline: "OK", reason: "Within plan", figures: [] };
    const failed = { status: "failed" as const, error: "timeout" };
    const cancelled = { status: "cancelled", reason: "simulation_stopped" };
    for (const [id, kind] of [["expense", "expense"], ["extra", "income"], ["salary", "income"],
      ["purchase", "purchase"], ["judge", "purchase"], ["complete", "expense"], ["manual", "expense"],
      ["failed", "expense"], ["parsed-later", "expense"]] as const) {
      store.beginRequest(id, kind, id);
      store.state.requests[id]!.source = id === "manual" ? "user" : "sim";
    }
    store.recordExpense({ ...expense, requestId: "expense" });
    store.state.requests.extra!.parsed = { amount: 100, kind: "extra", source: "Gift" };
    store.state.requests.salary!.parsed = { amount: 250000, kind: "salary", source: "Salary" };
    store.state.requests.complete!.parsed = { amount: 100, category: "food", note: "Coffee" };
    store.state.requests.complete!.verdicts = { Pace: verdict, Anomaly: failed, Coach: verdict };
    store.state.requests.failed!.error = "invalid_parser_answer";
    store.state.requests.expense!.verdicts = { Pace: verdict, Anomaly: failed };
    store.state.requests.purchase!.verdicts = { Impact: verdict };
    store.state.requests.judge!.verdicts = { Impact: verdict, Obligations: verdict, "Deal Check": verdict, Alternatives: failed };
    const periods = structuredClone(store.state.periods);
    for (const id of ["expense", "extra", "salary", "purchase", "judge", "parsed-later"]) {
      expect(store.cancelSimulationRequest(id)).toMatchObject({ status: "cancelled", reason: "simulation_stopped" });
      expect(store.cancelSimulationRequest(id)).toBeUndefined();
    }
    expect(store.state.requests.expense!.verdicts).toEqual({ Pace: verdict, Anomaly: failed, Coach: cancelled });
    expect(store.state.requests.extra!.verdicts).toEqual({ Pace: cancelled, Coach: cancelled });
    expect(store.state.requests.salary!.verdicts).toEqual({ Planner: cancelled, Obligations: cancelled });
    expect(store.state.requests.purchase!.verdicts).toEqual({
      Impact: verdict, Obligations: cancelled, "Deal Check": cancelled, Alternatives: cancelled,
    });
    expect(store.state.requests.judge!.verdicts).toEqual({ Impact: verdict, Obligations: verdict, "Deal Check": verdict, Alternatives: failed });
    for (const id of ["complete", "manual", "failed", "missing"]) {
      expect(store.cancelSimulationRequest(id)).toBeUndefined();
      expect(store.state.requests[id]?.status).toBeUndefined();
    }
    store.beginRequest("judged", "purchase", "Headphones");
    store.state.requests.judged!.source = "sim";
    store.putJudgement("judged", { decision: "wait", why: "Later", figures: [] });
    expect(store.cancelSimulationRequest("judged")).toBeUndefined();
    expect(store.state.periods).toEqual(periods);
    StateResponse.parse(store.snapshot());
  });
});
