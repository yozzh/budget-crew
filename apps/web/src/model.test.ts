import { describe, expect, it } from "vitest";
import type { ActivityEnvelope, Period, StateEnvelope, StateResponse } from "@budget-crew/shared";
import { acceptRequest, applyEnvelope, initialModel, SnapshotSync, type ViewModel } from "./model.js";

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
    after = applyEnvelope(after, { v: 1, at, type: "purchase.parsed", data: { requestId: "buy", purchase: { item: "Shoes", price: 5000, category: "clothing" } } });
    expect(after.snapshot!.requests.buy!.parsed).toMatchObject({ price: 5000 });
    after = applyEnvelope(after, { v: 1, at, type: "request.failed", data: { requestId: "buy", error: "Invalid input" } });
    expect(after.snapshot!.requests.buy!.error).toBe("Invalid input");
    after = applyEnvelope(after, { v: 1, at, type: "period.closed", data: { periodId: "period", finalBalance: 11000 } });
    expect(after.snapshot!.currentPeriodId).toBeUndefined();
    expect(after.snapshot!.periods[0]).toMatchObject({ status: "closed", finalBalance: 11000 });
    after = applyEnvelope(after, { v: 1, at, type: "simulation.tick", data: { day: "2026-11-27", running: true } });
    expect(after.snapshot!.today).toBe("2026-11-27");
  });
});

describe("snapshot synchronization", () => {
  it("buffers publications while the snapshot loads", async () => {
    const { promise, resolve } = Promise.withResolvers<StateResponse>();
    let current = model();
    const sync = new SnapshotSync(() => promise, () => current, (next) => { current = next; });
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
});
