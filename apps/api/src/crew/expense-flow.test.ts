import "reflect-metadata";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DeveloperMessageItem, ModelMessageItem, UserMessageItem, type InferenceInput, type InferenceOutput } from "@mozaik-ai/core";
import {
  AcceptedResponse, ActivityEnvelope, NoOpenPeriodError, ParsedIncome, StateEnvelope, StateResponse,
} from "@budget-crew/shared";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { closePeriod } from "@budget-crew/budget";
import { BudgetStore } from "../budget/budget.store.js";
import { StubInferenceRunner } from "../inference/stub-inference.runner.js";
import { CentrifugoPublisher } from "../realtime/centrifugo.publisher.js";
import { CrewModule } from "./crew.module.js";

type Publication = { channel: string; envelope: ActivityEnvelope | StateEnvelope };
const verdictAgents = ["Pace", "Anomaly", "Coach"] as const;
let app: INestApplication | undefined;
let forbiddenFetch: Mock | undefined;
const euros = expect.stringMatching(/^-?€\d{1,3}(?:,\d{3})*\.\d{2}$/);

function agentContext(input: InferenceInput): unknown {
  const instruction = input.context.items.find(item => item instanceof DeveloperMessageItem);
  expect(instruction).toBeInstanceOf(DeveloperMessageItem);
  const text = (instruction as DeveloperMessageItem).content.text;
  expect(text).toContain("Quote monetary strings exactly as supplied");
  expect(text).toContain("never convert or compute money");
  expect(text).toContain("Never use minor-unit terminology");
  expect(text).not.toMatch(/cents/i);
  const message = input.context.items.filter(item => item instanceof UserMessageItem).at(-1)!;
  return JSON.parse(message.content.text.slice(message.content.text.indexOf("{"))) as unknown;
}

afterEach(async () => {
  vi.useRealTimers();
  try {
    await app?.close();
    expect(forbiddenFetch).not.toHaveBeenCalled();
  } finally {
    app = undefined;
    forbiddenFetch = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
});

async function setup() {
  vi.stubEnv("INFERENCE", "stub");
  vi.stubEnv("MOZAIK_API_KEY", "must-never-connect");
  vi.stubEnv("OPENAI_API_KEY", "must-never-connect");
  forbiddenFetch = vi.fn(() => { throw new Error("Network forbidden"); });
  vi.stubGlobal("fetch", forbiddenFetch);
  const publications: Publication[] = [];
  vi.spyOn(CentrifugoPublisher.prototype, "publish").mockImplementation(async (channel, envelope) => {
    publications.push({ channel, envelope: structuredClone(envelope) });
  });
  app = await NestFactory.create(CrewModule, { logger: false });
  app.setGlobalPrefix("api");
  await app.listen(25200, "127.0.0.1");
  const port = (app.getHttpServer().address() as AddressInfo).port;
  const store = app.get(BudgetStore);
  store.reset("2026-11-26");

  // HTTP uses node:http so every fetch remains forbidden, including model traffic.
  function http(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request({ hostname: "127.0.0.1", port, path: `/api${path}`, method, agent: false,
        headers: payload === undefined ? {} : { "content-type": "application/json" },
      }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { text += chunk; });
        res.on("error", reject);
        res.on("end", () => {
          try { resolve({ status: res.statusCode!, body: text ? JSON.parse(text) as unknown : undefined }); }
          catch (error) { reject(error); }
        });
      });
      req.on("error", reject);
      req.end(payload);
    });
  }
  async function state() {
    const response = await http("GET", "/state");
    expect(response.status).toBe(200);
    return StateResponse.parse(response.body);
  }
  async function submit(text: string) {
    const response = await http("POST", "/expenses", { text });
    expect(response.status).toBe(202);
    return AcceptedResponse.parse(response.body).requestId;
  }
  function activities(requestId: string) {
    return publications.flatMap(({ envelope }) => envelope.type === "agent.activity"
      && envelope.data.requestId === requestId ? [ActivityEnvelope.parse(envelope).data] : []);
  }
  function validatePublications() {
    for (const { channel, envelope } of publications) {
      if (envelope.type === "agent.activity") {
        expect(channel).toBe("crew:activity");
        ActivityEnvelope.parse(envelope);
      } else {
        expect(channel).toBe("crew:state");
        StateEnvelope.parse(envelope);
      }
    }
  }
  return { store, stub: app.get(StubInferenceRunner), publications, http, state, submit, activities, validatePublications };
}

function modelAnswer(text: string): InferenceOutput {
  return { items: [ModelMessageItem.rehydrate({ text })], tokenUsage: undefined, rowResponse: undefined };
}

async function completed(store: BudgetStore, requestId: string, agents: readonly string[] = verdictAgents) {
  await vi.waitFor(() => {
    const verdicts = store.state.requests[requestId]!.verdicts;
    expect(Object.keys(verdicts).sort()).toEqual([...agents].sort());
    for (const agent of agents) expect(verdicts[agent as keyof typeof verdicts]).toHaveProperty("level");
  }, { timeout: 2900, interval: 10 });
}

describe("expense HTTP flow", () => {
  it("records a 350-cent expense and overlaps three verdict agents within three seconds", async () => {
    const { store, stub, publications, state, submit, activities, validatePublications } = await setup();
    const inference = vi.spyOn(stub, "run");
    const before = await state();
    const text = "Кофе и круассан за 3,50 € — личная заметка";
    const started = Date.now();
    const requestId = await submit(text);
    await completed(store, requestId);
    expect(Date.now() - started).toBeLessThan(3000);

    const snapshot = await state();
    const requestState = snapshot.requests[requestId]!;
    expect(requestState).toMatchObject({ kind: "expense", input: text, parsed: { amount: 350 } });
    expect(requestState.error).toBeUndefined();
    const period = snapshot.periods.find((entry) => entry.id === snapshot.currentPeriodId)!;
    const previous = before.periods.find((entry) => entry.id === before.currentPeriodId)!;
    expect(period.expenses).toHaveLength(previous.expenses.length + 1);
    expect(period.expenses.filter((expense) => expense.requestId === requestId)).toEqual([
      expect.objectContaining({ amount: 350, source: "user", date: snapshot.today }),
    ]);
    const expenseBefore = previous.projection.find((day) => day.date === snapshot.today)!.expense;
    expect(period.projection.find((day) => day.date === snapshot.today)!.expense).toBe(expenseBefore + 350);
    for (const agent of verdictAgents) {
      const calls = inference.mock.calls.filter(([input]) => input.structuredOutput?.name === `${agent}Verdict`);
      expect(calls.length).toBeGreaterThan(0);
      for (const [input] of calls) expect(agentContext(input)).toMatchObject({
        requestId,
        expense: { amount: "€3.50", category: "food", note: "coffee" },
        projectionToday: { date: snapshot.today, allowance: euros, expense: euros, remaining: euros, nextAllowance: euros },
      });
    }
    const recorded = publications.find(({ envelope }) => envelope.type === "expense.recorded")!.envelope;
    expect(recorded).toMatchObject({ data: { expense: { amount: 350 }, projectionToday: { remaining: expect.any(Number) } } });

    const activity = activities(requestId);
    expect(activity.findIndex((event) => event.agent === "Parser" && event.phase === "answered"))
      .toBeLessThan(activity.findIndex((event) => event.agent === "Pace" && event.phase === "received"));
    const verdictActivity = activity.filter((event) => verdictAgents.some((agent) => agent === event.agent));
    const received = verdictActivity.flatMap((event, index) => event.phase === "received" ? [index] : []);
    expect(received).toHaveLength(3);
    expect(Math.max(...received)).toBeLessThan(verdictActivity.findIndex((event) => event.phase === "answered"));
    expect(new Set(verdictActivity.filter((event) => event.phase === "received").map((event) => event.agent)))
      .toEqual(new Set(verdictAgents));
    expect(new Set(verdictActivity.map((event) => event.loopId)).size).toBe(3);
    expect(publications.filter(({ envelope }) => envelope.type === "expense.recorded"
      && envelope.data.requestId === requestId)).toHaveLength(1);
    expect(publications.filter(({ envelope }) => envelope.type === "verdict.recorded"
      && envelope.data.requestId === requestId)).toHaveLength(3);
    validatePublications();
  });

  it("rejects invalid Parser JSON output without changing expenses", async () => {
    const { stub, store, publications, submit, state, validatePublications } = await setup();
    const before = await state();
    const run = stub.run.bind(stub);
    vi.spyOn(stub, "run").mockImplementation((input) => input.structuredOutput?.name === "ParsedExpense"
      ? Promise.resolve(modelAnswer('{"amount":"not-an-integer","category":"food","note":"invalid"}'))
      : run(input));
    const requestId = await submit("invalid parser expense");
    await vi.waitFor(() => expect(store.state.requests[requestId]!.error).toEqual(expect.any(String)));
    const snapshot = await state();
    expect(snapshot.requests[requestId]!.error).not.toBe("");
    expect(snapshot.requests[requestId]!.verdicts).toEqual({});
    expect(snapshot.periods).toEqual(before.periods);
    expect(publications).toContainEqual({ channel: "crew:state", envelope: expect.objectContaining({
      type: "request.failed", data: { requestId, error: snapshot.requests[requestId]!.error },
    }) });
    expect(publications.some(({ envelope }) => envelope.type === "expense.recorded")).toBe(false);
    validatePublications();
  });

  it("ignores a Parser answer from before reset", async () => {
    const { stub, store, publications, submit } = await setup();
    let answerParser!: (output: InferenceOutput) => void;
    const parserAnswer = new Promise<InferenceOutput>((resolve) => { answerParser = resolve; });
    vi.spyOn(stub, "run").mockReturnValue(parserAnswer);
    await submit("coffee before reset");
    store.reset("2026-11-26");
    const reset = store.snapshot();
    answerParser(modelAnswer(JSON.stringify({ amount: 350, category: "food", note: "late" })));
    await vi.waitFor(() => expect(publications.some(({ envelope }) => envelope.type === "agent.activity"
      && envelope.data.agent === "Parser" && envelope.data.phase === "answered")).toBe(true));
    expect(store.snapshot()).toEqual(reset);
    expect(publications.some(({ envelope }) => envelope.type === "expense.recorded")).toBe(false);
  });

  it("times out a missing Coach answer at the 45-second deadline", async () => {
    const { stub, store, publications, submit, state, validatePublications } = await setup();
    const run = stub.run.bind(stub);
    let answerCoach!: (output: InferenceOutput) => void;
    const coachAnswer = new Promise<InferenceOutput>((resolve) => { answerCoach = resolve; });
    vi.spyOn(stub, "run").mockImplementation((input) => input.structuredOutput?.name === "CoachVerdict"
      ? coachAnswer : run(input));
    const nativeTimeout = globalThis.setTimeout;
    let expire: (() => void) | undefined;
    let deadline: NodeJS.Timeout | undefined;
    // Keep HTTP and random node:timers/promises delays real until the other
    // agents finish; then transfer the captured deadline to fake timers.
    const timeout = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
      const timer = nativeTimeout(callback, delay, ...args);
      if (delay === 45_000) {
        expire = () => callback(...args);
        deadline = timer;
      }
      return timer;
    });
    const requestId = await submit("coffee 3.50");
    await vi.waitFor(() => {
      expect(store.state.requests[requestId]!.verdicts.Pace).toHaveProperty("level");
      expect(store.state.requests[requestId]!.verdicts.Anomaly).toHaveProperty("level");
      expect(expire).toBeTypeOf("function");
    }, { timeout: 2900 });
    expect(store.state.requests[requestId]!.verdicts.Coach).toBeUndefined();
    clearTimeout(deadline);
    timeout.mockRestore();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      setTimeout(expire!, 45_000);
      await vi.advanceTimersByTimeAsync(44_999);
      expect(store.state.requests[requestId]!.verdicts.Coach).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(store.state.requests[requestId]!.verdicts.Coach)
        .toMatchObject({ status: "failed", error: expect.any(String) });
    } finally {
      vi.useRealTimers();
    }
    const snapshot = await state();
    expect(snapshot.requests[requestId]!.verdicts.Pace).toHaveProperty("level");
    expect(snapshot.requests[requestId]!.verdicts.Anomaly).toHaveProperty("level");
    expect(snapshot.periods.flatMap((period) => period.expenses).filter((expense) => expense.requestId === requestId))
      .toHaveLength(1);
    expect(publications).toContainEqual({ channel: "crew:state", envelope: expect.objectContaining({
      type: "verdict.recorded", data: expect.objectContaining({ requestId, agent: "Coach", verdict: expect.objectContaining({ status: "failed" }) }),
    }) });
    expect(snapshot.requests[requestId]!.error).toBeUndefined();
    expect(publications.some(({ envelope }) => envelope.type === "request.failed")).toBe(false);
    answerCoach(modelAnswer(JSON.stringify({ level: "ok", headline: "Late advice", reason: "Too late", figures: [] })));
    await vi.waitFor(() => expect(publications.some(({ envelope }) => envelope.type === "agent.activity"
      && envelope.data.agent === "Coach" && envelope.data.phase === "answered")).toBe(true));
    expect(store.state.requests[requestId]!.verdicts.Coach).toMatchObject({ status: "failed" });
    validatePublications();
  });

  it("returns 409 with no open period without creating a request or starting inference", async () => {
    const { store, stub, http, state, publications } = await setup();
    delete store.state.currentPeriodId;
    const before = await state();
    const run = vi.spyOn(stub, "run");
    const response = await http("POST", "/expenses", { text: "coffee 3.50" });
    expect(response.status).toBe(409);
    expect(NoOpenPeriodError.parse(response.body)).toEqual({ error: "no_open_period" });
    expect(await state()).toEqual(before);
    expect(run).not.toHaveBeenCalled();
    expect(publications).toEqual([]);
  });

  it("returns 400 for malformed text commands without mutating state", async () => {
    const { stub, http, state, publications } = await setup();
    const before = await state();
    const run = vi.spyOn(stub, "run");
    for (const body of [{}, { text: "   " }, { text: 350 }, { text: "coffee", unexpected: true }]) {
      expect((await http("POST", "/expenses", body)).status).toBe(400);
    }
    expect(await state()).toEqual(before);
    expect(run).not.toHaveBeenCalled();
    expect(publications).toEqual([]);
  });

  it("isolates simultaneous requests while sharing all four agents", async () => {
    const { store, submit, state, activities, validatePublications } = await setup();
    const before = await state();
    const texts = ["first coffee 3.50", "second coffee 3.50"];
    const ids = await Promise.all(texts.map(submit));
    expect(new Set(ids).size).toBe(2);
    await Promise.all(ids.map((id) => completed(store, id)));
    const snapshot = await state();
    const expenses = snapshot.periods.flatMap((period) => period.expenses);
    expect(expenses).toHaveLength(before.periods.flatMap((period) => period.expenses).length + 2);
    for (const [index, id] of ids.entries()) {
      expect(snapshot.requests[id]!.input).toBe(texts[index]);
      expect(expenses.filter((expense) => expense.requestId === id)).toHaveLength(1);
      const received = activities(id).filter((event) => event.phase === "received");
      expect(new Set(received.map((event) => event.agent))).toEqual(new Set(["Parser", ...verdictAgents]));
      expect(new Set(received.map((event) => event.loopId)).size).toBe(4);
    }
    const firstLoops = new Set(activities(ids[0]!).map((event) => event.loopId));
    expect(activities(ids[1]!).some((event) => firstLoops.has(event.loopId))).toBe(false);
    validatePublications();
  });
});

describe("income HTTP flow", () => {
  it("closes the old period, carries its balance, and overlaps Planner and Obligations", async () => {
    const { store, stub, http, publications, activities, validatePublications } = await setup();
    const inference = vi.spyOn(stub, "run");
    const previous = structuredClone(store.state.periods[0]!);
    const expectedBalance = closePeriod(previous, "2026-11-25").finalBalance;
    const response = await http("POST", "/incomes", { text: "salary 2500" });
    expect(response.status).toBe(202);
    const id = AcceptedResponse.parse(response.body).requestId;
    await completed(store, id, ["Planner", "Obligations"]);
    expect(store.state.requests[id]).toMatchObject({ kind: "income", parsed: { kind: "salary", amount: 250000 } });
    const period = store.state.periods.find(p => p.id === store.state.currentPeriodId)!;
    expect(period).toMatchObject({ start: "2026-11-26", carryover: expectedBalance, salary: { requestId: id, amount: 250000 } });
    expect(store.state.periods.find(p => p.id === previous.id)).toMatchObject({ status: "closed", finalBalance: expectedBalance });
    for (const agent of ["Planner", "Obligations"]) {
      const calls = inference.mock.calls.filter(([input]) => input.structuredOutput?.name === `${agent}Verdict`);
      expect(calls.length).toBeGreaterThan(0);
      for (const [input] of calls) expect(agentContext(input)).toMatchObject({
        requestId: id,
        period: {
          salary: { amount: "€2,500.00" },
          carryover: euros,
          articles: period.articles.map(article => ({ ...article, amount: euros })),
          projection: period.projection.map(day => ({
            ...day, allowance: euros, expense: euros, remaining: euros,
            ...(day.nextAllowance === undefined ? {} : { nextAllowance: euros }),
            ...(day.finalBalance === undefined ? {} : { finalBalance: euros }),
          })),
        },
      });
    }
    const changes = publications.flatMap(({ envelope }) => envelope.type === "period.closed" || envelope.type === "period.started" ? [envelope] : []);
    expect(changes.map(e => e.type)).toEqual(["period.closed", "period.started"]);
    expect(changes[0]!.data).toEqual({ periodId: previous.id, finalBalance: expectedBalance });
    const activity = activities(id).filter(e => e.agent === "Planner" || e.agent === "Obligations");
    expect(new Set(activity.filter(e => e.phase === "received").map(e => e.agent))).toEqual(new Set(["Planner", "Obligations"]));
    expect(activity.map(e => e.phase).lastIndexOf("received")).toBeLessThan(activity.findIndex(e => e.phase === "answered"));
    expect(new Set(activity.map(e => e.loopId)).size).toBe(2);
    validatePublications();
  });

  it("adds extra income to today's allowance and runs only Pace and Coach", async () => {
    const { store, stub, http, publications, validatePublications } = await setup();
    stub.registerFixture("ParsedIncome", ParsedIncome, { amount: 5000, kind: "extra", source: "refund" });
    const inference = vi.spyOn(stub, "run");
    const before = store.state.periods[0]!.projection.find(p => p.date === store.state.today)!;
    const response = await http("POST", "/incomes", { text: "refund 50" });
    expect(response.status).toBe(202);
    const id = AcceptedResponse.parse(response.body).requestId;
    await completed(store, id, ["Pace", "Coach"]);
    const period = store.state.periods[0]!;
    const after = period.projection.find(p => p.date === store.state.today)!;
    expect(after.allowance).toBeGreaterThan(before.allowance);
    expect(after.remaining).toBe(before.remaining + 5000);
    expect(period.extraIncomes).toEqual([expect.objectContaining({ requestId: id, amount: 5000, date: store.state.today })]);
    for (const agent of ["Pace", "Coach"]) {
      const calls = inference.mock.calls.filter(([input]) => input.structuredOutput?.name === `${agent}Verdict`);
      expect(calls.length).toBeGreaterThan(0);
      for (const [input] of calls) expect(agentContext(input)).toMatchObject({
        requestId: id,
        income: { amount: "€50.00", kind: "extra", source: "refund" },
        projectionToday: { date: store.state.today, allowance: euros, expense: euros, remaining: euros, nextAllowance: euros },
      });
    }
    expect(publications.filter(({ envelope }) => envelope.type === "income.recorded")).toEqual([
      { channel: "crew:state", envelope: expect.objectContaining({ data: expect.objectContaining({ requestId: id, remaining: after.remaining }) }) },
    ]);
    expect(publications.some(({ envelope }) => envelope.type === "period.started")).toBe(false);
    validatePublications();
  });

  it("accepts salary after HTTP reset with no open period, then accepts expenses", async () => {
    const { store, http, submit, validatePublications } = await setup();
    expect((await http("POST", "/reset")).status).toBe(204);
    // Also exercise the initially empty simulation state; the endpoint must not require an open period.
    store.state.periods = [];
    delete store.state.currentPeriodId;
    expect((await http("POST", "/expenses", { text: "coffee" })).status).toBe(409);
    const response = await http("POST", "/incomes", { text: "salary 2500" });
    expect(response.status).toBe(202);
    await completed(store, AcceptedResponse.parse(response.body).requestId, ["Planner", "Obligations"]);
    await completed(store, await submit("coffee 3.50"));
    validatePublications();
  });

  it("fails extra income without an open period with the precise reason and no mutation", async () => {
    const { store, stub, http, publications } = await setup();
    stub.registerFixture("ParsedIncome", ParsedIncome, { amount: 5000, kind: "extra", source: "refund" });
    store.state.periods = [];
    delete store.state.currentPeriodId;
    const response = await http("POST", "/incomes", { text: "refund 50" });
    expect(response.status).toBe(202);
    const id = AcceptedResponse.parse(response.body).requestId;
    await vi.waitFor(() => expect(store.state.requests[id]!.error).toBe("no_open_period"));
    expect(store.state.periods).toEqual([]);
    expect(store.state.requests[id]!.verdicts).toEqual({});
    expect(publications).toContainEqual({ channel: "crew:state", envelope: expect.objectContaining({
      type: "request.failed", data: { requestId: id, error: "no_open_period" },
    }) });
  });

  it("rejects malformed input and invalid income output without changing periods", async () => {
    const { store, stub, http } = await setup();
    const before = structuredClone(store.state.periods);
    expect((await http("POST", "/incomes", { text: " " })).status).toBe(400);
    vi.spyOn(stub, "run").mockResolvedValue(modelAnswer('{"amount":-1,"kind":"salary","source":"invalid"}'));
    const response = await http("POST", "/incomes", { text: "salary" });
    const id = AcceptedResponse.parse(response.body).requestId;
    await vi.waitFor(() => expect(store.state.requests[id]!.error).toBe("invalid_parser_answer"));
    expect(store.state.periods).toEqual(before);
  });

  it("ignores an income Parser answer arriving after reset", async () => {
    const { store, stub, http, publications } = await setup();
    // The workspace targets ES2023, before Promise.withResolvers' type declarations.
    let resolve!: (output: InferenceOutput) => void;
    const promise = new Promise<InferenceOutput>(done => { resolve = done; });
    vi.spyOn(stub, "run").mockReturnValue(promise);
    const response = await http("POST", "/incomes", { text: "salary" });
    expect(response.status).toBe(202);
    store.reset("2026-11-26");
    const reset = store.snapshot();
    resolve(modelAnswer('{"amount":250000,"kind":"salary","source":"late"}'));
    await vi.waitFor(() => expect(publications.some(({ envelope }) => envelope.type === "agent.activity"
      && envelope.data.agent === "Parser" && envelope.data.phase === "answered")).toBe(true));
    expect(store.snapshot()).toEqual(reset);
    expect(publications.some(({ envelope }) => envelope.type === "period.started")).toBe(false);
  });
});
