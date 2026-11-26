import { describe, expect, it } from "vitest";
import type { Period, RequestState, StateResponse } from "@budget-crew/shared";
import { classifyEntry, deriveHistory, initialMode, requestSummary } from "./basic.js";

describe("one-input routing", () => {
  it.each([
    ["can I buy a jacket for €90?", "purchase"],
    ["salary 2500", "income"],
    ["coffee 3.50", "expense"],
    ["Can I afford AirPods for 179", "purchase"],
    ["should I buy this laptop", "purchase"],
    ["Is this deal good?", "purchase"],
    ["Could I get a bike for 300", "purchase"],
    ["income from freelance work 200", "income"],
    ["got 50 from a friend", "income"],
    ["earned 300 this weekend", "income"],
    ["received a refund of 40", "income"],
    ["groceries 54.90", "expense"],
    ["bought a jacket for 90", "expense"],
    ["Can I spend my salary on a laptop?", "purchase"],
    ["forgot lunch 8", "expense"],
  ])("routes %s to %s", (text, kind) => expect(classifyEntry(text)).toBe(kind));
});

it("gives the URL priority over the remembered display mode", () => {
  expect(initialMode("?mode=basic", "pro")).toBe("basic");
  expect(initialMode("?mode=pro", "basic")).toBe("pro");
  expect(initialMode("", "pro")).toBe("pro");
  expect(initialMode("?mode=unknown", null)).toBe("basic");
});

const verdict = (headline: string) => ({ level: "ok" as const, headline, reason: "Budget checked", figures: [] });
const request: RequestState = { kind: "expense", input: "coffee 3.50", createdAt: "2026-06-04T12:00:00Z", verdicts: { Coach: verdict("Keep the habit small"), Pace: verdict("You are on pace.") } };
it("combines advice with Pace first regardless of arrival order", () => {
  expect(requestSummary(request)).toBe("You are on pace. Keep the habit small");
});

const june: Period = {
  id: "june", status: "closed", start: "2026-06-01", end: "2026-06-30",
  salary: { id: "salary", date: "2026-06-01", amount: 200000, kind: "salary", source: "demo" },
  carryover: -1000, extraIncomes: [{ id: "extra", date: "2026-06-05", amount: 10000, kind: "extra", source: "demo" }],
  articles: [{ id: "rent", name: "Rent", amount: 80000, dueDate: "2026-06-01", paid: true }],
  expenses: [{ id: "coffee", date: "2026-06-04", amount: 350, category: "food", note: "coffee", source: "user" }],
  projection: [{ date: "2026-06-01", allowance: 4000, expense: 4000, remaining: 125000 }, { date: "2026-06-30", allowance: 4000, expense: 350, remaining: 124650 }],
  finalBalance: 124650,
};
const state: StateResponse = {
  profile: { name: "Demo", currency: "EUR", payday: 1, recurringArticles: [] },
  today: "2026-11-26", periods: [june, { ...june, id: "november", status: "open", start: "2026-11-01", end: "2026-11-30" }],
  simulation: { running: false, speed: 4 }, requests: {
    coffee: request,
    purchase: { ...request, kind: "purchase", createdAt: "2026-06-09T12:00:00Z", judgement: { decision: "wait", why: "Wait for a better price.", figures: [] } },
    delayed: { ...request, date: "2026-06-30", createdAt: "2026-07-01T12:00:00Z" },
    july: { ...request, createdAt: "2026-07-01T12:00:00Z" },
  },
};
it("uses accounted spending, reserved bills and final balance, not just recorded expenses", () => {
  const history = deriveHistory(state);
  expect(history.map(({ period, spent, balance, requests, moment }) => ({ id: period.id, spent, balance, ids: requests.map(([id]) => id), moment }))).toEqual([
    { id: "june", spent: 84350, balance: 124650, ids: ["coffee", "purchase", "delayed"], moment: "Wait for a better price." },
  ]);
});
it("derives negative leftovers when a closed period has no final balance", () => {
  expect(deriveHistory({ ...state, periods: [{ ...june, finalBalance: undefined, salary: { ...june.salary, amount: 70000 }, extraIncomes: [] }] })[0]?.balance).toBe(-15350);
});
it("keeps each of five closed periods in calendar order and excludes the open month", () => {
  const periods = [10, 8, 6, 9, 7].map((month) => ({ ...june, id: String(month), start: `2026-${String(month).padStart(2, "0")}-01` as Period["start"] }));
  expect(deriveHistory({ ...state, periods: [...periods, state.periods[1]!] }).map(({ period }) => period.id)).toEqual(["6", "7", "8", "9", "10"]);
});
it("has no invented history before the first month closes", () => {
  expect(deriveHistory({ ...state, periods: state.periods.filter((period) => period.status === "open") })).toEqual([]);
});
