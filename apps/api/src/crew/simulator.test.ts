import "reflect-metadata";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { InferenceOutput } from "@mozaik-ai/core";
import { openPeriod, simulateBudget, type Period, type Profile } from "@budget-crew/budget";
import { ActivityEnvelope, SimulationMonth, StateEnvelope, StateResponse } from "@budget-crew/shared";
import { afterEach, expect, it, vi } from "vitest";
import { BudgetStore } from "../budget/budget.store.js";
import { StubInferenceRunner } from "../inference/stub-inference.runner.js";
import { CentrifugoPublisher } from "../realtime/centrifugo.publisher.js";
import { CrewModule } from "./crew.module.js";
import { ExpenseFlow } from "./expense-flow.js";

const month = SimulationMonth.parse(JSON.parse(readFileSync(new URL("../../../../seed/month.json", import.meta.url), "utf8")));
const expectedExpenses = month.days.flatMap(day => day.expenses.map(input => ({ date: day.date, input })));
let app: INestApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup() {
  vi.stubEnv("INFERENCE", "stub");
  vi.stubEnv("MOZAIK_API_KEY", "must-never-connect");
  vi.stubEnv("OPENAI_API_KEY", "must-never-connect");
  const network = vi.fn(() => { throw new Error("Network forbidden"); });
  vi.stubGlobal("fetch", network);
  const publications: (ActivityEnvelope | StateEnvelope)[] = [];
  vi.spyOn(CentrifugoPublisher.prototype, "publish").mockImplementation(async (channel, envelope) => {
    expect(channel).toBe(envelope.type === "agent.activity" ? "crew:activity" : "crew:state");
    publications.push(structuredClone(envelope));
  });
  app = await NestFactory.create(CrewModule, { logger: false });
  app.setGlobalPrefix("api");
  await app.listen(Number(process.env.TEST_PORT ?? 0), "127.0.0.1");
  const port = (app.getHttpServer().address() as AddressInfo).port;
  const http = (method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ hostname: "127.0.0.1", port, path: `/api${path}`, method, agent: false,
      headers: payload === undefined ? {} : { "content-type": "application/json" } }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) as unknown : undefined }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(payload);
  });
  const store = app.get(BudgetStore);
  function validate() {
    expect(network).not.toHaveBeenCalled();
    StateResponse.parse(store.snapshot());
    for (const publication of publications) (publication.type === "agent.activity" ? ActivityEnvelope : StateEnvelope).parse(publication);
  }
  return { store, stub: app.get(StubInferenceRunner), publications, http, validate };
}

it("leaves a tight Black Friday budget with affordable discount, weak deal and unaffordable candidates", () => {
  const { profile } = JSON.parse(readFileSync(new URL("../../../../seed/synthetic-user.json", import.meta.url), "utf8")) as { profile: Profile };
  const prices = JSON.parse(readFileSync(new URL("../../../../seed/price-history.json", import.meta.url), "utf8")) as {
    item: string; history: { date: string; price: number }[];
  }[];
  const amount = (text: string): number => {
    const match = /€(\d+)\.(\d{2})\b/.exec(text);
    expect(match, text).not.toBeNull();
    return Number(match![1]) * 100 + Number(match![2]);
  };
  const today = "2026-11-27";
  let period: Period | undefined;
  for (const day of month.days.filter(day => day.date < today)) {
    for (const [index, text] of day.incomes.entries()) {
      const income = { id: `${day.date}:income:${index}`, date: day.date, amount: amount(text), source: text };
      if (!period) period = openPeriod(profile, { ...income, kind: "salary" }, 0);
      else period.extraIncomes.push({ ...income, kind: "extra" });
    }
    for (const [index, text] of day.expenses.entries()) {
      period!.expenses.push({
        id: `${day.date}:expense:${index}`, date: day.date, amount: amount(text),
        category: "", note: text, source: "sim",
      });
    }
  }
  const budget = simulateBudget(period!, today, { amount: 0 });
  expect(budget.remaining.before).toBeGreaterThanOrEqual(25000);
  expect(budget.remaining.before).toBeLessThanOrEqual(35000);
  expect(budget.todayAllowance.before).toBeGreaterThanOrEqual(6000);
  expect(budget.todayAllowance.before).toBeLessThanOrEqual(9000);

  const blackFriday = month.days.find(day => day.date === today)!;
  expect(blackFriday.expenses).toEqual([]);
  expect(blackFriday.purchases).toHaveLength(4);
  const purchases = blackFriday.purchases.map(text => {
    const item = /^Can I buy (.+) for €/.exec(text)![1];
    const history = prices.find(entry => entry.item === item);
    expect(history, item).toBeDefined();
    const recent = history!.history.filter(entry => entry.date >= "2026-08-29" && entry.date < today);
    expect(recent).toHaveLength(90);
    const price = amount(text);
    return { price, low: Math.min(...recent.map(entry => entry.price)), impact: simulateBudget(period!, today, { amount: price }) };
  });
  expect(purchases.some(({ price, low, impact }) =>
    !impact.goesNegative && price < budget.remaining.before * .2 && price < low)).toBe(true);
  expect(purchases.some(({ price, low, impact }) =>
    !impact.goesNegative && price >= low && impact.remaining.after >= 0)).toBe(true);
  expect(purchases.some(({ impact }) => impact.goesNegative && impact.remaining.after < 0)).toBe(true);
});

it("runs the complete month at .05 with real stub jitter, recording every expense once and judging all four day-27 purchases", async () => {
  const { store, publications, http, validate } = await setup();
  expect((await http("POST", "/simulation", { speed: .05 })).status).toBe(202);
  expect(await http("POST", "/simulation", { speed: .05 })).toEqual({ status: 409, body: { error: "simulation_running" } });
  await vi.waitFor(() => {
    expect(store.state.simulation).toEqual({ running: false, day: "2026-11-30", speed: .05 });
    const requests = Object.values(store.state.requests).filter(entry => entry.source === "sim" && entry.date?.startsWith("2026-11-"));
    expect(requests).toHaveLength(expectedExpenses.length + 6);
    for (const entry of requests) {
      expect(entry.error).toBeUndefined();
      expect(entry.parsed).toBeDefined();
      if (entry.kind === "purchase") expect(entry.judgement).toHaveProperty("decision");
      else expect(Object.keys(entry.verdicts)).toHaveLength(entry.kind === "expense" ? 3 : 2);
    }
  }, { timeout: 8000, interval: 10 });

  const snapshot = store.snapshot();
  expect(snapshot.today).toBe("2026-11-30");
  expect(snapshot.periods).toHaveLength(6);
  const period = snapshot.periods.find(period => period.id === snapshot.currentPeriodId)!;
  expect(period).toMatchObject({ status: "open", start: "2026-11-01", end: "2026-11-30", salary: { date: "2026-11-01", amount: 250000 } });
  expect(period.expenses).toHaveLength(expectedExpenses.length);
  expect(new Set(period.expenses.map(expense => expense.requestId)).size).toBe(expectedExpenses.length);
  expect(period.extraIncomes).toEqual([expect.objectContaining({ date: "2026-11-15", kind: "extra", amount: 18000 })]);
  for (const expected of expectedExpenses) {
    const matches = Object.entries(snapshot.requests).filter(([, entry]) => entry.kind === "expense" && entry.date === expected.date && entry.input === expected.input);
    expect(matches).toHaveLength(1);
    const [requestId, entry] = matches[0]!;
    expect(entry.source).toBe("sim");
    expect(period.expenses.filter(expense => expense.requestId === requestId)).toEqual([
      expect.objectContaining({ date: expected.date, source: "sim" }),
    ]);
    expect(entry.parsed).toMatchObject({ amount: Math.round(Number(/€(\d+\.\d{2})/.exec(expected.input)![1]) * 100) });
    expect(publications.filter(event => event.type === "expense.recorded" && event.data.requestId === requestId)).toHaveLength(1);
  }
  const purchases = Object.entries(snapshot.requests).filter(([, entry]) => entry.kind === "purchase" && entry.source === "sim" && entry.date?.startsWith("2026-11-"));
  expect(purchases).toHaveLength(4);
  for (const [requestId, entry] of purchases) {
    expect(entry).toMatchObject({ date: "2026-11-27", source: "sim" });
    expect(Object.keys(entry.verdicts).sort()).toEqual(["Alternatives", "Deal Check", "Impact", "Obligations"]);
    expect(publications.filter(event => event.type === "purchase.judged" && event.data.requestId === requestId)).toHaveLength(1);
    expect(publications.filter(event => event.type === "agent.activity" && event.data.requestId === requestId
      && event.data.agent === "Judge" && event.data.phase === "received")).toHaveLength(1);
  }
  expect(publications.filter(event => event.type === "period.started")).toHaveLength(1);
  expect(publications.filter(event => event.type === "period.closed")).toHaveLength(0);
  expect(publications.flatMap(event => event.type === "simulation.tick" ? [event.data.day] : [])).toEqual(month.days.map(day => day.date));
  expect(publications.filter(event => event.type === "simulation.finished")).toEqual([
    expect.objectContaining({ data: { day: "2026-11-30", running: false, speed: .05 } }),
  ]);
  validate();
}, 12000);

it("queues parsed simulated expenses until a delayed day-one salary opens the current period", async () => {
  const { store, stub, publications, http, validate } = await setup();
  const history = structuredClone(store.state.periods.filter(period => period.status === "closed"));
  const run = stub.run.bind(stub);
  // ES2023 is the configured lib; Promise.withResolvers is not available.
  let release!: () => void;
  const salaryGate = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  vi.spyOn(stub, "run").mockImplementation(async input => {
    if (!held && input.structuredOutput?.name === "ParsedIncome") {
      held = true;
      await salaryGate;
    }
    return run(input);
  });
  await http("POST", "/simulation", { speed: .05 });
  try {
    await vi.waitFor(() => {
      expect(publications.some(event => event.type === "agent.activity" && event.data.agent === "Parser" && event.data.phase === "answered")).toBe(true);
      expect(store.state.today > "2026-11-01").toBe(true);
    }, { timeout: 1500, interval: 5 });
    expect(store.state.periods).toEqual(history);
    expect(store.state.periods).toHaveLength(5);
    expect(store.state.periods.every(period => period.status === "closed")).toBe(true);
    expect(store.state.currentPeriodId).toBeUndefined();
    expect(Object.values(store.state.requests).filter(entry => entry.source === "sim" && entry.date?.startsWith("2026-11-")).every(entry => entry.error === undefined)).toBe(true);
  } finally { release(); }
  await vi.waitFor(() => {
    expect(store.state.periods).toHaveLength(6);
    const period = store.state.periods.find(period => period.id === store.state.currentPeriodId)!;
    expect(period.expenses.some(expense => expense.date === "2026-11-01" && expense.source === "sim")).toBe(true);
  }, { timeout: 2000, interval: 5 });
  expect(store.state.periods.find(period => period.id === store.state.currentPeriodId)!.salary.date).toBe("2026-11-01");
  expect(publications.filter(event => event.type === "period.started")).toHaveLength(1);
  await http("DELETE", "/simulation");
  validate();
});

it("defaults to four seconds per day and rejects invalid speed without resetting manual state", async () => {
  const { store, http, validate } = await setup();
  const before = store.snapshot();
  for (const body of [null, { speed: 0 }, { speed: -1 }, { speed: "1" }, { speed: .05, other: true }]) {
    expect((await http("POST", "/simulation", body)).status).toBe(400);
    expect(store.snapshot()).toEqual(before);
  }
  expect(await http("POST", "/simulation", {})).toMatchObject({ status: 202, body: { running: true, day: "2026-11-01", speed: 4 } });
  expect((await http("DELETE", "/simulation")).status).toBe(204);
  validate();
});

it.each(["stop", "reset", "shutdown"] as const)("invalidates delayed simulation parsing and scheduled ticks on %s", async action => {
  const { store, stub, publications, http, validate } = await setup();
  const historyRequests = structuredClone(store.state.requests);
  const run = stub.run.bind(stub);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending: Promise<InferenceOutput>[] = [];
  vi.spyOn(stub, "run").mockImplementation(input => {
    const output = gate.then(() => run(input));
    pending.push(output);
    return output;
  });
  await http("POST", "/simulation", { speed: .05 });
  await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0), { interval: 5 });
  if (action === "shutdown") {
    await app!.close();
    app = undefined;
  } else {
    expect((await http(action === "stop" ? "DELETE" : "POST", action === "stop" ? "/simulation" : "/reset")).status).toBe(204);
  }
  const stopped = store.snapshot();
  if (action === "reset") expect(stopped.requests).toEqual(historyRequests);
  else {
    for (const entry of Object.values(stopped.requests).filter(entry => entry.source === "sim" && entry.date?.startsWith("2026-11-"))) {
      expect(entry).toMatchObject({ status: "cancelled", reason: "simulation_stopped" });
      expect(entry.parsed).toBeUndefined();
    }
  }
  const publicationCount = publications.length;
  release();
  await Promise.all(pending);
  await nextTurn();
  expect(store.snapshot()).toEqual(stopped);
  expect(publications).toHaveLength(publicationCount);
  expect(publications.some(event => event.type === "simulation.finished")).toBe(false);
  validate();
});

it("cancels adviser deadlines and ignores late answers even when stopped after natural finish", async () => {
  const { store, stub, publications, http, validate } = await setup();
  const run = stub.run.bind(stub);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending: Promise<InferenceOutput>[] = [];
  const deadlines = vi.spyOn(globalThis, "setTimeout");
  const cancel = vi.spyOn(globalThis, "clearTimeout");
  vi.spyOn(stub, "run").mockImplementation(input => {
    const output = input.structuredOutput?.name?.endsWith("Verdict") ? gate.then(() => run(input)) : run(input);
    pending.push(output);
    return output;
  });
  await http("POST", "/simulation", { speed: .05 });
  try {
    await vi.waitFor(() => {
      expect(store.state.simulation.running).toBe(false);
      expect(publications.some(event => event.type === "simulation.finished")).toBe(true);
      expect(deadlines.mock.calls.some(([, delay]) => delay === 45000)).toBe(true);
    }, { timeout: 3000, interval: 5 });
    await http("DELETE", "/simulation");
    const stopped = store.snapshot();
    const publicationCount = publications.length;
    const adviserDeadlines = deadlines.mock.calls.flatMap(([callback, delay], index) => delay === 45000 || delay === 60000 ? [{ callback, handle: deadlines.mock.results[index]!.value as NodeJS.Timeout }] : []);
    for (const { callback, handle } of adviserDeadlines) {
      expect(cancel).toHaveBeenCalledWith(handle);
      if (typeof callback === "function") callback(); // A deadline already dequeued when cancellation happened.
    }
    release();
    // Tool-backed stub loops may enqueue one more inference after their first output.
    let count: number;
    do {
      count = pending.length;
      await Promise.all(pending);
      await nextTurn();
    } while (pending.length !== count);
    expect(store.snapshot()).toEqual(stopped);
    expect(publications).toHaveLength(publicationCount);
  } finally { release(); }
  validate();
}, 8000);

it("terminalizes unfinished day requests once on stop without cancelling manual work or accepting late answers", async () => {
  const { store, stub, publications, http, validate } = await setup();
  const run = stub.run.bind(stub);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending: Promise<InferenceOutput>[] = [];
  vi.spyOn(stub, "run").mockImplementation(input => {
    const output = input.structuredOutput?.name?.endsWith("Verdict") ? gate.then(() => run(input)) : run(input);
    pending.push(output);
    return output;
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await http("POST", "/simulation", { speed: 4 });
    await vi.waitFor(() => {
      const requests = Object.values(store.state.requests).filter(entry => entry.source === "sim" && entry.date?.startsWith("2026-11-"));
      expect(requests).toHaveLength(month.days[0]!.incomes.length + month.days[0]!.expenses.length);
      expect(requests.every(entry => entry.parsed)).toBe(true);
      expect(publications.some(event => event.type === "agent.activity" && event.data.agent === "Pace" && event.data.phase === "received")).toBe(true);
    }, { timeout: 2500, interval: 10 });
    const manualId = app!.get(ExpenseFlow).submit("Coffee €3.50").requestId;
    await vi.waitFor(() => expect(store.state.requests[manualId]?.parsed).toBeDefined(), { interval: 10 });
    const manual = structuredClone(store.state.requests[manualId]);
    const money = structuredClone(store.state.periods);
    const simIds = Object.keys(store.state.requests).filter(id => store.state.requests[id]!.source === "sim" && store.state.requests[id]!.date?.startsWith("2026-11-"));
    await http("DELETE", "/simulation");
    for (const id of simIds) {
      const entry = store.state.requests[id]!;
      expect(entry).toMatchObject({ status: "cancelled", reason: "simulation_stopped" });
      const agents = entry.kind === "income" ? ["Planner", "Obligations"] : ["Pace", "Anomaly", "Coach"];
      expect(entry.verdicts).toEqual(Object.fromEntries(agents.map(agent => [agent, { status: "cancelled", reason: "simulation_stopped" }])));
      expect(publications.filter(event => event.type === "request.cancelled" && event.data.requestId === id)).toEqual([
        expect.objectContaining({ data: { requestId: id, request: entry, inference: { mode: "stub" } } }),
      ]);
    }
    expect(store.state.requests[manualId]).toEqual(manual);
    expect(store.state.periods).toEqual(money);
    const cancelled = structuredClone(Object.fromEntries(simIds.map(id => [id, store.state.requests[id]])));
    const count = publications.filter(event => event.type === "request.cancelled").length;
    const stoppedPublicationCount = publications.length;
    await http("DELETE", "/simulation");
    await vi.advanceTimersByTimeAsync(46_000);
    release();
    let size: number;
    do {
      size = pending.length;
      await Promise.all(pending);
      await nextTurn();
    } while (pending.length !== size);
    expect(Object.fromEntries(simIds.map(id => [id, store.state.requests[id]]))).toEqual(cancelled);
    expect(publications.filter(event => event.type === "request.cancelled")).toHaveLength(count);
    expect(publications.slice(stoppedPublicationCount).filter(event => "requestId" in event.data
      && event.data.requestId !== undefined && simIds.includes(event.data.requestId))).toEqual([]);
    await http("POST", "/simulation", { speed: 4 });
    for (const id of simIds) expect(store.state.requests[id]).toBeUndefined();
    expect(store.state.simulation.running).toBe(true);
    await http("DELETE", "/simulation");
    validate();
  } finally {
    release();
    vi.useRealTimers();
  }
}, 8000);
