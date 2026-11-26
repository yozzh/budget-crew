import { describe, expect, it } from "vitest";
import type { ActivityEnvelope, BudgetSimulation, Period, RequestState, StateEnvelope, StateResponse } from "@budget-crew/shared";
import { acceptRequest, applyEnvelope, initialModel, SnapshotSync, type ViewModel } from "./model.js";
import { allowanceChartData } from "./chart.js";

const at = "2026-11-26T12:00:00Z";
const day = { date: "2026-11-26" as const, allowance: 2000, expense: 0, remaining: 10000, nextAllowance: 2000 };
const period: Period = { id: "period", status: "open", start: "2026-11-01", end: "2026-11-30", salary: { id: "salary", date: "2026-11-01", amount: 60000, kind: "salary", source: "Demo" }, carryover: 0, articles: [], expenses: [], extraIncomes: [], projection: [day] };
function snapshot(): StateResponse {
  return { profile: { name: "Demo", currency: "EUR", payday: 1, recurringArticles: [] }, today: "2026-11-26", currentPeriodId: period.id, periods: [structuredClone(period)], requests: { req: { input: "Coffee 5 EUR", kind: "expense", verdicts: {}, createdAt: at } }, simulation: { running: false, speed: 1 } };
}
function model(): ViewModel { return { ...initialModel, snapshot: snapshot() }; }
const expense: StateEnvelope = { v: 1, at, type: "expense.recorded", data: { requestId: "req", expense: { id: "coffee", date: "2026-11-26", amount: 500, category: "food", note: "Coffee", source: "user" }, projectionToday: { ...day, expense: 500, remaining: 9500, nextAllowance: 2375 }, remaining: 9500 } };
const verdict: StateEnvelope = { v: 1, at, type: "verdict.recorded", data: { requestId: "req", agent: "Pace", verdict: { level: "ok", headline: "On pace", reason: "Within the plan", figures: [] } } };
const activity: ActivityEnvelope = { v: 1, at, type: "agent.activity", data: { agent: "Pace", loopId: "one", requestId: "req", phase: "thinking" } };
const simulation: BudgetSimulation = {
  todayAllowance: { before: 2000, after: 2000 }, nextAllowance: { before: 2000, after: 750 },
  deltaPerDay: -1250, remaining: { before: 10000, after: 5000 }, daysLeft: 4, goesNegative: false,
};
const purchase: StateEnvelope = { v: 1, at, type: "purchase.parsed", data: { requestId: "buy", purchase: { item: "Shoes", price: 5000, category: "clothing" }, simulation } };

describe("view model", () => {
  it("records an expense once, with parsed values and server projection", () => {
    const before = model();
    const after = applyEnvelope(before, expense);
    expect(after.snapshot!.requests.req!.parsed).toEqual({ amount: 500, category: "food", note: "Coffee" });
    expect(after.snapshot!.periods[0]!.projection[0]).toEqual(expense.data.projectionToday);
    expect(applyEnvelope(after, expense)).toEqual(after);
    expect(before.snapshot!.periods[0]!.expenses).toEqual([]);
  });
  it("fills verdict and purchase judgement without losing input", () => {
    const after = applyEnvelope(model(), verdict);
    expect(after.snapshot!.requests.req!.verdicts.Pace).toEqual(verdict.data.verdict);
    const judgement = { decision: "wait" as const, why: "Protect the buffer", figures: [{ label: "Remaining", value: "EUR 95" }] };
    const judged = applyEnvelope(after, { v: 1, at, type: "purchase.judged", data: { requestId: "buy", judgement } });
    expect(judged.snapshot!.requests.buy).toMatchObject({ kind: "purchase", judgement });
    expect(judged.snapshot!.requests.req!.input).toBe("Coffee 5 EUR");
  });
  it("keeps purchase budget context unchanged after spending and advancing the day", () => {
    const parsed = applyEnvelope(model(), purchase);
    const stored = structuredClone(parsed.snapshot!.requests.buy);
    const spent = applyEnvelope(parsed, expense);
    const advanced = applyEnvelope(spent, { v: 1, at, type: "simulation.tick", data: { day: "2026-11-27", running: true, speed: 4 } });
    expect(advanced.snapshot!.periods[0]!.projection[0]!.remaining).toBe(9500);
    expect(advanced.snapshot!.today).toBe("2026-11-27");
    expect(advanced.snapshot!.requests.buy).toEqual(stored);
    expect(advanced.snapshot!.requests.buy!.simulation).toEqual(simulation);
    expect(parsed.snapshot!.requests.buy!.simulation).toEqual(simulation);
  });
  it.each(["expense", "income", "purchase"] as const)("applies cancellation for an unseen %s without guessing its kind", (kind) => {
    const request: RequestState = {
      kind, input: "Simulation entry", source: "sim", createdAt: at,
      status: "cancelled", reason: "simulation_stopped",
      verdicts: { Parser: { status: "cancelled", reason: "simulation_stopped" } },
    };
    const after = applyEnvelope(model(), { v: 1, at, type: "request.cancelled", data: { requestId: "unseen", request } });
    expect(after.snapshot!.requests.unseen).toEqual(request);
    expect(after.snapshot!.periods).toEqual(model().snapshot!.periods);
  });
  it("keeps completed and failed slots and recorded money when cancellation arrives", () => {
    const before = applyEnvelope(applyEnvelope(model(), expense), verdict);
    const failed = { status: "failed" as const, error: "Timed out" };
    const request: RequestState = {
      ...before.snapshot!.requests.req!, status: "cancelled", reason: "simulation_stopped",
      verdicts: { Pace: verdict.data.verdict, Anomaly: failed, Coach: { status: "cancelled", reason: "simulation_stopped" } },
    };
    const event: StateEnvelope = { v: 1, at, type: "request.cancelled", data: { requestId: "req", request } };
    const after = applyEnvelope(before, event);
    expect(after.snapshot!.requests.req).toEqual(request);
    expect(after.snapshot!.periods).toEqual(before.snapshot!.periods);
    expect(applyEnvelope(after, event)).toEqual(after);
    expect(acceptRequest(after, "req", { input: "Coffee 5 EUR", kind: "expense", verdicts: {}, createdAt: at }).snapshot!.requests.req).toEqual(request);
    expect(before.snapshot!.requests.req!.status).toBeUndefined();
  });
  it("starts a salary period and preserves existing periods", () => {
    const next = { ...period, id: "next", carryover: -200 };
    const after = applyEnvelope(model(), { v: 1, at, type: "period.started", data: { requestId: "salary", period: next } });
    expect(after.snapshot!.currentPeriodId).toBe("next");
    expect(after.snapshot!.periods).toHaveLength(2);
    expect(after.snapshot!.requests.salary!.parsed).toMatchObject({ kind: "salary", amount: 60000 });
  });
  it("keeps concurrent loops when an older loop finishes", () => {
    let after = applyEnvelope(model(), activity);
    after = applyEnvelope(after, { ...activity, data: { ...activity.data, loopId: "two" } });
    after = applyEnvelope(after, { ...activity, data: { ...activity.data, phase: "answered" } });
    expect(after.activity["Pace:two"]!.data.phase).toBe("thinking");
    expect(after.activity["Pace:one"]!.data.phase).toBe("answered");
    expect(applyEnvelope(after, { v: 1, at, type: "state.reset", data: {} })).toMatchObject({ reload: true, activity: {} });
  });
  it("merges POST acknowledgement with verdicts arriving first", () => {
    const after = acceptRequest(applyEnvelope(model(), verdict), "req", { kind: "expense", input: "Coffee 5 EUR", createdAt: at, verdicts: {} });
    expect(after.snapshot!.requests.req!.verdicts.Pace).toEqual(verdict.data.verdict);
  });
  it("applies income, parsing, failure, closure and simulation events", () => {
    let after = applyEnvelope(model(), { v: 1, at, type: "income.recorded", data: { requestId: "extra", income: { id: "extra", date: "2026-11-26", amount: 1000, kind: "extra", source: "Demo" }, projectionToday: { ...day, remaining: 11000 }, remaining: 11000 } });
    expect(after.snapshot!.periods[0]!.extraIncomes[0]!.amount).toBe(1000);
    after = applyEnvelope(after, purchase);
    expect(after.snapshot!.requests.buy!.parsed).toMatchObject({ price: 5000 });
    after = applyEnvelope(after, { v: 1, at, type: "request.failed", data: { requestId: "buy", error: "Invalid input" } });
    expect(after.snapshot!.requests.buy!.error).toBe("Invalid input");
    after = applyEnvelope(after, { v: 1, at, type: "period.closed", data: { periodId: "period", finalBalance: 11000 } });
    expect(after.snapshot!.currentPeriodId).toBeUndefined();
    expect(after.snapshot!.periods[0]).toMatchObject({ status: "closed", finalBalance: 11000 });
    after = applyEnvelope(after, { v: 1, at, type: "simulation.tick", data: { day: "2026-11-27", running: true, speed: 4 } });
    expect(after.snapshot!.today).toBe("2026-11-27");
    expect(after.snapshot!.simulation).toEqual({ day: "2026-11-27", running: true, speed: 4 });
    after = applyEnvelope(after, { v: 1, at, type: "simulation.finished", data: { day: "2026-11-30", running: false, speed: 4 } });
    expect(after.snapshot!.today).toBe("2026-11-30");
    expect(after.snapshot!.simulation).toEqual({ day: "2026-11-30", running: false, speed: 4 });
  });
});

describe("snapshot synchronization", () => {
  it("retains purchase simulation through snapshot loading and reconnect replay", async () => {
    const saved = applyEnvelope(model(), purchase).snapshot!;
    let current = model();
    const sync = new SnapshotSync(async () => structuredClone(saved), () => current, (next) => { current = next; });
    await sync.reload();
    expect(current.snapshot!.requests.buy!.simulation).toEqual(simulation);
    const { promise, resolve } = Promise.withResolvers<StateResponse>();
    const reconnect = new SnapshotSync(() => promise, () => current, (next) => { current = next; });
    reconnect.receive({ v: 1, at, type: "state.reset", data: {} });
    reconnect.receive(purchase);
    resolve(snapshot());
    await promise;
    expect(current.snapshot!.requests.buy!.parsed).toEqual(purchase.data.purchase);
    expect(current.snapshot!.requests.buy!.simulation).toEqual(simulation);
    expect(current.reload).toBe(false);
  });
  it("loads cancelled snapshots and replays cancellation over an older snapshot", async () => {
    const stopped = snapshot();
    stopped.requests.req = {
      ...stopped.requests.req!, status: "cancelled", reason: "simulation_stopped",
      verdicts: { Pace: verdict.data.verdict, Anomaly: { status: "failed", error: "Timed out" }, Coach: { status: "cancelled", reason: "simulation_stopped" } },
    };
    let current = model();
    const sync = new SnapshotSync(async () => stopped, () => current, (next) => { current = next; });
    await sync.reload();
    expect(current.snapshot!.requests.req).toEqual(stopped.requests.req);
    const { promise, resolve } = Promise.withResolvers<StateResponse>();
    const delayed = new SnapshotSync(() => promise, () => current, (next) => { current = next; });
    const loading = delayed.reload();
    delayed.receive({ v: 1, at, type: "request.cancelled", data: { requestId: "req", request: stopped.requests.req! } });
    resolve(snapshot());
    await loading;
    expect(current.snapshot!.requests.req).toEqual(stopped.requests.req);
    expect(current.snapshot!.periods).toEqual(stopped.periods);
  });
  it("buffers publications while the snapshot loads", async () => {
    const { promise, resolve } = Promise.withResolvers<StateResponse>();
    let current = model();
    const fresh = snapshot();
    fresh.periods[0]!.expenses = [expense.data.expense];
    fresh.periods[0]!.projection = [expense.data.projectionToday];
    fresh.requests.req!.verdicts.Pace = verdict.data.verdict;
    let loads = 0;
    const sync = new SnapshotSync(() => ++loads === 1 ? promise : Promise.resolve(fresh), () => current, (next) => { current = next; });
    const loading = sync.reload();
    sync.receive(expense);
    sync.receive(verdict);
    resolve(snapshot());
    await loading;
    expect(current.snapshot!.periods[0]!.expenses[0]!.id).toBe("coffee");
    expect(current.snapshot!.requests.req!.verdicts.Pace).toEqual(verdict.data.verdict);
  });
  it("rejects a stale snapshot after reset and replays only new events", async () => {
    const resolvers: ((value: StateResponse) => void)[] = [];
    let current = model();
    const sync = new SnapshotSync(() => {
      const { promise, resolve } = Promise.withResolvers<StateResponse>();
      resolvers.push(resolve);
      return promise;
    }, () => current, (next) => { current = next; });
    const old = sync.reload();
    sync.receive(expense);
    sync.receive({ v: 1, at, type: "state.reset", data: {} });
    const fresh = snapshot();
    fresh.requests = {};
    resolvers[1]!(fresh);
    await Promise.resolve();
    resolvers[0]!(snapshot());
    await old;
    expect(current.snapshot!.requests).toEqual({});
    expect(current.snapshot!.periods[0]!.expenses).toEqual([]);
  });
  it.each(["expense", "income", "tick", "finished"] as const)("refreshes the full future projection after %s", async (kind) => {
    let current = model();
    const fresh = snapshot();
    const future = { ...day, date: "2026-11-27" as const, allowance: 2375 };
    fresh.periods[0]!.projection = [day, future];
    const income: StateEnvelope = { v: 1, at, type: "income.recorded", data: { requestId: "extra", income: { id: "extra", date: day.date, amount: 1000, kind: "extra", source: "Side job" }, projectionToday: { ...day, remaining: 11000 }, remaining: 11000 } };
    let event: StateEnvelope;
    if (kind === "expense") {
      event = expense;
      fresh.periods[0]!.expenses = [expense.data.expense];
    } else if (kind === "income") {
      event = income;
      fresh.periods[0]!.extraIncomes = [income.data.income];
      future.allowance = 2625;
    } else {
      event = kind === "tick"
        ? { v: 1, at, type: "simulation.tick", data: { day: "2026-11-27", running: true, speed: 4 } }
        : { v: 1, at, type: "simulation.finished", data: { day: "2026-11-27", running: false, speed: 4 } };
      fresh.today = "2026-11-27";
      fresh.simulation = { day: "2026-11-27", running: kind === "tick", speed: 4 };
    }
    let loads = 0;
    const sync = new SnapshotSync(async () => { ++loads; return fresh; }, () => current, (next) => { current = next; });
    sync.receive(event);
    await Promise.resolve();
    expect(loads).toBe(1);
    expect(current.snapshot!.periods[0]!.projection).toEqual([day, future]);
    expect(allowanceChartData(current.snapshot!.periods[0]).at(-1)!.actual).toBe(future.allowance / 100);
    sync.dispose();
  });
  it("refetches when redistribution lands during an in-flight snapshot", async () => {
    const first = Promise.withResolvers<StateResponse>();
    const second = Promise.withResolvers<StateResponse>();
    let current = model();
    let loads = 0;
    const sync = new SnapshotSync(() => ++loads === 1 ? first.promise : second.promise, () => current, (next) => { current = next; });
    const loading = sync.reload();
    sync.receive(expense);
    first.resolve(snapshot());
    await loading;
    expect(loads).toBe(2);
    const fresh = snapshot();
    fresh.periods[0]!.expenses = [expense.data.expense];
    fresh.periods[0]!.projection = [expense.data.projectionToday, { ...day, date: "2026-11-27", allowance: 2375 }];
    second.resolve(fresh);
    await Promise.resolve();
    expect(current.snapshot!.periods[0]!.projection[1]!.allowance).toBe(2375);
    expect(current.snapshot!.periods[0]!.expenses).toEqual([expense.data.expense]);
    sync.dispose();
  });
});
