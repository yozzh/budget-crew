import { describe, expect, it } from "vitest";
import {
  AcceptedResponse, BudgetSimulation, BudgetStateSnapshot, HealthResponse, NoOpenPeriodError,
  RequestState, RuntimeEventPayloads, SimulationInput, StateEnvelope, StateResponse, StateSchema, TextCommand,
} from "./index.js";
import type { Period, Income, Expense, DayProjection } from "@budget-crew/budget";

const at = "2026-11-26T12:00:00.000Z";
const day = "2026-11-26";
const income: Income = { id: "salary", date: day, amount: 100000, source: "Employer", kind: "salary" };
const expense: Expense = { id: "expense", requestId: "req", date: day, amount: 1000, category: "food", note: "Lunch", source: "user" };
const projectionToday: DayProjection = { date: day, allowance: 20000, expense: 1000, remaining: 99000, nextAllowance: 24500 };
const purchase = { item: "Headphones", price: 9900, category: "electronics" };
const verdict = { level: "warn" as const, headline: "Wait", reason: "Allowance would fall", figures: [] };
const judgement = { decision: "wait" as const, why: "Save first", figures: [] };
const simulation = {
  todayAllowance: { before: 20000, after: 20000 }, nextAllowance: { before: 24500, after: 22025 },
  deltaPerDay: -2475, remaining: { before: 99000, after: 89100 }, daysLeft: 5, goesNegative: false,
};
const period: Period = {
  id: "period", status: "open", start: day, end: "2026-11-30", salary: income, carryover: -100,
  extraIncomes: [], articles: [{ id: "rent", name: "Rent", amount: 10000, dueDate: day, paid: false }],
  expenses: [expense], projection: [projectionToday],
};
const request = { kind: "purchase" as const, input: "Check headphones", verdicts: {}, createdAt: at };
const snapshot = {
  profile: { name: "Demo", currency: "EUR", payday: 1, recurringArticles: [{ name: "Rent", amount: 10000, dueDay: 1 }] },
  periods: [period], currentPeriodId: "period", today: day, requests: { req: request },
  simulation: { running: false, speed: 1 },
};

it("accepts a flat architecture snapshot and preserves the requests record", () => {
  for (const schema of [BudgetStateSnapshot, StateSchema, StateResponse]) {
    expect(schema.parse(snapshot)).toEqual(snapshot);
    expect(schema.safeParse({ ...snapshot, requests: [request] }).success).toBe(false);
    expect(schema.safeParse({ ...snapshot, positions: {} }).success).toBe(false);
    expect(schema.safeParse({ snapshot }).success).toBe(false);
    expect(schema.safeParse({ ...snapshot, profile: { ...snapshot.profile, payday: 32 } }).success).toBe(false);
    expect(schema.safeParse({ ...snapshot, today: "2026-02-30" }).success).toBe(false);
  }
});

it("supports no open period, no requests and optional simulation day", () => {
  const closed = { ...snapshot, currentPeriodId: undefined };
  expect(BudgetStateSnapshot.parse({ ...closed, periods: [], requests: {}, simulation: { running: true, day, speed: 2 } })).toMatchObject({
    periods: [], requests: {}, simulation: { running: true, day, speed: 2 },
  });
});

it("allows an unparsed request and each complete parser output", () => {
  expect(RequestState.parse(request)).toEqual(request);
  for (const parsed of [
    { amount: 1000, category: "food", note: "Lunch" }, purchase,
    { amount: 100000, kind: "salary", source: "Employer" },
  ]) {
    expect(RequestState.parse({ ...request, parsed }).parsed).toEqual(parsed);
  }
  expect(RequestState.safeParse({ ...request, parsed: { amount: 1000 } }).success).toBe(false);
  expect(RequestState.safeParse({ ...request, kind: "refund" }).success).toBe(false);
  expect(RequestState.safeParse({ ...request, createdAt: day }).success).toBe(false);
});

it("validates partial verdict slots and optional judgement", () => {
  const verdicts = { Impact: verdict, "Deal Check": { status: "failed", error: "Timed out" } };
  expect(RequestState.parse({ ...request, verdicts, judgement })).toMatchObject({ verdicts, judgement });
  expect(RequestState.safeParse({ ...request, verdicts: { Ledger: verdict } }).success).toBe(false);
  expect(RequestState.safeParse({ ...request, verdicts: { Impact: { status: "failed" } } }).success).toBe(false);
  expect(RequestState.safeParse({ ...request, judgement: { decision: "buy" } }).success).toBe(false);
});

it("represents undefined final-day allowances with omitted wire fields", () => {
  const lastDay = { ...simulation, nextAllowance: { before: undefined, after: undefined }, daysLeft: 1, deltaPerDay: 0 };
  expect(BudgetSimulation.parse(lastDay)).toEqual(lastDay);
  const wire: unknown = JSON.parse(JSON.stringify(lastDay));
  expect(BudgetSimulation.parse(wire).nextAllowance).toEqual({});
  expect(BudgetSimulation.safeParse({ ...lastDay, nextAllowance: { before: null, after: null } }).success).toBe(false);
  expect(BudgetSimulation.safeParse({ ...lastDay, daysLeft: 0 }).success).toBe(false);
});

const runtimePayloads = {
  "expense.submitted": { requestId: "req", text: "Lunch 10 EUR", date: day },
  "purchase.submitted": { requestId: "req", text: "Headphones 99 EUR" },
  "income.submitted": { requestId: "req", text: "Salary 1000 EUR", date: day },
  "model.answer": { loopId: "loop", answer: JSON.stringify(verdict) },
  "expense.recorded": { requestId: "req", expense, projectionToday },
  "income.recorded": { requestId: "req", income, projectionToday },
  "period.closed": { periodId: "period", finalBalance: -100 },
  "period.started": { requestId: "req", period },
  "purchase.parsed": { requestId: "req", purchase },
  "verdict.recorded": { requestId: "req", agent: "Impact", verdict },
  "purchase.ready": { requestId: "req", verdicts: { Impact: verdict }, simulation },
  "purchase.judged": { requestId: "req", judgement },
  "day.advanced": { day },
  "simulation.*": { day },
  "message_received.*": { loopId: "loop", message: "[req:req] Lunch" },
  "inference.*": { loopId: "loop", model: "stub" },
  "function_call.*": { loopId: "loop", name: "budget_snapshot" },
};

it("covers every runtime payload table entry and rejects malformed payloads", () => {
  expect(Object.keys(RuntimeEventPayloads)).toEqual(Object.keys(runtimePayloads));
  for (const type of Object.keys(RuntimeEventPayloads) as (keyof typeof RuntimeEventPayloads)[]) {
    const schema = RuntimeEventPayloads[type];
    expect(schema.parse(runtimePayloads[type])).toEqual(runtimePayloads[type]);
    expect(schema.safeParse({}).success).toBe(false);
  }
  expect(RuntimeEventPayloads["expense.submitted"].safeParse({ requestId: "req", text: "Lunch" }).success).toBe(false);
  expect(RuntimeEventPayloads["purchase.parsed"].safeParse({ requestId: "req", purchase: { amount: 9900 } }).success).toBe(false);
  expect(RuntimeEventPayloads["purchase.ready"].safeParse({ requestId: "req", verdicts: {}, simulation: {} }).success).toBe(false);
  expect(RuntimeEventPayloads["verdict.recorded"].safeParse({ requestId: "req", agent: "Impact", verdict: { status: "failed", error: "Timeout" } }).success).toBe(true);
});

const statePayloads = {
  "period.started": runtimePayloads["period.started"],
  "period.closed": runtimePayloads["period.closed"],
  "income.recorded": { ...runtimePayloads["income.recorded"], remaining: 99000 },
  "expense.recorded": { ...runtimePayloads["expense.recorded"], remaining: 99000 },
  "purchase.parsed": runtimePayloads["purchase.parsed"],
  "verdict.recorded": runtimePayloads["verdict.recorded"],
  "purchase.judged": runtimePayloads["purchase.judged"],
  "simulation.tick": { day, running: true },
  "state.reset": {},
};

it("validates every discriminated crew state envelope", () => {
  expect(StateEnvelope.options).toHaveLength(Object.keys(statePayloads).length);
  for (const [type, data] of Object.entries(statePayloads)) {
    const publication = { v: 1, type, at, data };
    expect(StateEnvelope.parse(publication)).toEqual(publication);
    expect(StateEnvelope.safeParse({ ...publication, v: 2 }).success).toBe(false);
    expect(StateEnvelope.safeParse({ ...publication, at: day }).success).toBe(false);
    expect(StateEnvelope.safeParse({ ...publication, data: { ...data, extra: true } }).success).toBe(false);
  }
  expect(StateEnvelope.safeParse({ v: 1, type: "purchase.ready", at, data: runtimePayloads["purchase.ready"] }).success).toBe(false);
  expect(StateEnvelope.safeParse({ v: 1, type: "income.recorded", at, data: runtimePayloads["income.recorded"] }).success).toBe(false);
  expect(StateEnvelope.safeParse({ v: 1, type: "expense.recorded", at, data: runtimePayloads["expense.recorded"] }).success).toBe(false);
  expect(StateEnvelope.safeParse({ v: 1, type: "simulation.tick", at, data: { day } }).success).toBe(false);
  expect(StateEnvelope.safeParse({ v: 1, type: "purchase.parsed", at, data: runtimePayloads["purchase.judged"] }).success).toBe(false);
});

describe("HTTP contracts", () => {
  it("accepts text commands and rejects blank, missing, non-string or undeclared input", () => {
    expect(TextCommand.parse({ text: " Lunch 10 EUR " })).toEqual({ text: "Lunch 10 EUR" });
    for (const input of [{}, { text: "  " }, { text: 10 }, { text: "Lunch", amount: 1000 }]) {
      expect(TextCommand.safeParse(input).success).toBe(false);
    }
    expect(AcceptedResponse.parse({ requestId: "req" })).toEqual({ requestId: "req" });
    expect(AcceptedResponse.safeParse({ requestId: "" }).success).toBe(false);
  });

  it("requires positive simulation speed", () => {
    expect(SimulationInput.parse({ speed: 2 })).toEqual({ speed: 2 });
    for (const speed of [0, -1, Infinity, NaN, "2"]) {
      expect(SimulationInput.safeParse({ speed }).success).toBe(false);
    }
    expect(SimulationInput.safeParse({}).success).toBe(false);
  });

  it("preserves health and the no-open-period error shape", () => {
    for (const inference of ["live", "stub"]) {
      expect(HealthResponse.parse({ status: "ok", version: "0.0.0", inference })).toEqual({ status: "ok", version: "0.0.0", inference });
    }
    expect(HealthResponse.safeParse({ status: "down", version: "0.0.0", inference: "stub" }).success).toBe(false);
    expect(HealthResponse.safeParse({ status: "ok", version: "0.0.0", inference: "fake" }).success).toBe(false);
    expect(NoOpenPeriodError.parse({ error: "no_open_period" })).toEqual({ error: "no_open_period" });
    expect(NoOpenPeriodError.safeParse({ error: "no_period" }).success).toBe(false);
  });
});
