import "reflect-metadata";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DeveloperMessageItem, FunctionCallItem, ModelMessageItem, UserMessageItem, type InferenceInput, type InferenceOutput } from "@mozaik-ai/core";
import { AcceptedResponse, ActivityEnvelope, StateEnvelope, Verdict } from "@budget-crew/shared";
import { afterEach, expect, it, vi } from "vitest";
import { openPeriod, simulateBudget, upcomingObligations } from "@budget-crew/budget";
import { CrewRuntime } from "./crew-runtime.js";
import { formatMoneyFields } from "./money.js";
import { BudgetStore } from "../budget/budget.store.js";
import { StubInferenceRunner } from "../inference/stub-inference.runner.js";
import { CentrifugoPublisher } from "../realtime/centrifugo.publisher.js";
import { CrewModule } from "./crew.module.js";

const advisers = ["Impact", "Obligations", "Deal Check", "Alternatives"] as const;
let app: INestApplication | undefined;
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
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function setup() {
  vi.stubEnv("INFERENCE", "stub");
  vi.stubEnv("MOZAIK_API_KEY", "");
  const fetch = vi.fn(() => { throw new Error("Network forbidden"); });
  vi.stubGlobal("fetch", fetch);
  const events: (ActivityEnvelope | StateEnvelope)[] = [];
  vi.spyOn(CentrifugoPublisher.prototype, "publish").mockImplementation(async (_channel, envelope) => {
    events.push(structuredClone(envelope));
  });
  app = await NestFactory.create(CrewModule, { logger: false });
  app.setGlobalPrefix("api");
  await app.listen(25210, "127.0.0.1");
  const port = (app.getHttpServer().address() as AddressInfo).port;
  const store = app.get(BudgetStore);
  store.reset("2026-11-26");
  // ES2023 is the repository's compile-time library; withResolvers is unavailable.
  const http = (body: unknown, path = "/api/purchase-checks"): Promise<{ status: number; body: unknown }> => new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method: "POST",
      agent: false, headers: { "content-type": "application/json" } }, res => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(data) as unknown }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
  async function submit(text = "Can I buy AirPods for 180 euros?") {
    const response = await http({ text });
    expect(response.status).toBe(202);
    return AcceptedResponse.parse(response.body).requestId;
  }
  const activity = (id: string) => events.flatMap(e => e.type === "agent.activity" && e.data.requestId === id ? [e.data] : []);
  function validate() {
    expect(fetch).not.toHaveBeenCalled();
    for (const event of events) (event.type === "agent.activity" ? ActivityEnvelope : StateEnvelope).parse(event);
  }
  return { store, stub: app.get(StubInferenceRunner), events, http, submit, activity, validate };
}
const answer = (value: unknown): InferenceOutput => ({ items: [ModelMessageItem.rehydrate({ text: JSON.stringify(value) })], tokenUsage: undefined, rowResponse: undefined });
async function judged(store: BudgetStore, id: string) {
  await vi.waitFor(() => expect(store.state.requests[id]?.judgement).toHaveProperty("decision"), { timeout: 4000, interval: 10 });
}

it("overlaps four purchase advisers then runs exactly one Judge without changing budget", async () => {
  const { store, stub, submit, activity, events, validate } = await setup();
  stub.registerFixture("ImpactVerdict", Verdict, {
    level: "warn", headline: "Purchase impact reviewed", reason: "Review the supplied simulation.",
    figures: [{ label: "Purchase price", value: "€1,234.56" }],
  }, { name: "simulate_budget", args: { amount: "€180.00" } });
  const inference = vi.spyOn(stub, "run");
  const before = store.snapshot().periods;
  const id = await submit("Can I buy Laptop for €1234.56?");
  await judged(store, id);
  const state = store.state.requests[id]!;
  expect(state).toMatchObject({ kind: "purchase", parsed: { item: "Laptop", price: 123456 } });
  expect(Object.keys(state.verdicts).sort()).toEqual([...advisers].sort());
  expect(store.snapshot().periods).toEqual(before);
  for (const name of ["ImpactVerdict", "ObligationsVerdict", "DealCheckVerdict", "AlternativesVerdict", "Judgement"]) {
    const calls = inference.mock.calls.filter(([input]) => input.structuredOutput?.name === name);
    expect(calls.length).toBeGreaterThan(0);
    for (const [input] of calls) {
      expect(agentContext(input)).toMatchObject({
        requestId: id, purchase: { item: "Laptop", price: "€1,234.56", category: "electronics" },
        ...(name === "Judgement" ? {
          verdicts: { Impact: { figures: [{ label: "Purchase price", value: "€1,234.56" }] } },
          simulation: {
            todayAllowance: { before: euros, after: euros },
            nextAllowance: { before: euros, after: euros },
            remaining: { before: euros, after: euros },
            deltaPerDay: euros, daysLeft: expect.any(Number), goesNegative: expect.any(Boolean),
          },
        } : {}),
      });
    }
  }
  const simulationCalls = inference.mock.calls.flatMap(([input]) => input.context.items
    .filter(item => item instanceof FunctionCallItem && item.name === "simulate_budget"));
  expect(simulationCalls.length).toBeGreaterThan(0);
  for (const call of simulationCalls) expect(JSON.parse((call as FunctionCallItem).args)).toEqual({ amount: "€1,234.56" });
  expect(events.find(event => event.type === "purchase.parsed")).toMatchObject({
    data: { purchase: { price: 123456 } },
  });
  const activities = activity(id);
  const received = advisers.map(agent => activities.findIndex(e => e.agent === agent && e.phase === "received"));
  const answered = advisers.map(agent => activities.findIndex(e => e.agent === agent && e.phase === "answered"));
  expect(Math.min(...received)).toBeGreaterThanOrEqual(0);
  expect(Math.max(...received)).toBeLessThan(Math.min(...answered));
  const judges = activities.filter(e => e.agent === "Judge" && e.phase === "received");
  expect(judges).toHaveLength(1);
  expect(activities.indexOf(judges[0]!)).toBeGreaterThan(Math.max(...answered));
  expect(events.filter(e => e.type === "purchase.judged" && e.data.requestId === id)).toHaveLength(1);
  for (const agent of ["Impact", "Obligations", "Deal Check", "Judge"]) {
    expect(activities.some(e => e.agent === agent && e.phase === "tool")).toBe(true);
  }
  for (const agent of ["Deal Check", "Alternatives"] as const) {
    expect(activities.filter(e => e.agent === agent && e.phase === "tool" && e.tool === "web_search")).toHaveLength(1);
    expect(state.verdicts[agent]).toMatchObject({
      figures: expect.arrayContaining([{ label: "Source", value: expect.stringMatching(/\.example €\d+\.\d{2}$/) }]),
    });
  }
  validate();
});

it("fills missing purchase advisers at 75 seconds, judges once and ignores late answers", async () => {
  const { store, stub, submit, activity, validate } = await setup();
  const run = stub.run.bind(stub);
  const releases: ((output: InferenceOutput) => void)[] = [];
  vi.spyOn(stub, "run").mockImplementation(input => input.structuredOutput?.name?.endsWith("Verdict")
    ? new Promise<InferenceOutput>(resolve => { releases.push(resolve); }) : run(input));
  const nativeTimeout = globalThis.setTimeout;
  const deadlines: { timer: NodeJS.Timeout; expire: () => void }[] = [];
  const timeout = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
    const timer = nativeTimeout(callback, delay, ...args);
    if (delay === 75000) deadlines.push({ timer, expire: () => callback(...args) });
    return timer;
  });
  const id = await submit();
  await vi.waitFor(() => expect(releases).toHaveLength(4), { timeout: 3000 });
  expect(deadlines).toHaveLength(4);
  expect(store.state.requests[id]!.judgement).toBeUndefined();
  for (const { timer } of deadlines) clearTimeout(timer);
  timeout.mockRestore();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  for (const { expire } of deadlines) setTimeout(expire, 75000);
  await vi.advanceTimersByTimeAsync(74999);
  expect(store.state.requests[id]!.verdicts).toEqual({});
  await vi.advanceTimersByTimeAsync(1);
  for (const agent of advisers) expect(store.state.requests[id]!.verdicts[agent]).toEqual({ status: "failed", error: "timeout" });
  vi.useRealTimers();
  await judged(store, id);
  for (const release of releases) release(answer({ level: "ok", headline: "Late", reason: "Late", figures: [] }));
  await vi.waitFor(() => expect(activity(id).some(e => e.agent === "Alternatives" && e.phase === "answered")).toBe(true));
  expect(store.state.requests[id]!.verdicts.Alternatives).toHaveProperty("status", "failed");
  expect(activity(id).filter(e => e.agent === "Judge" && e.phase === "received")).toHaveLength(1);
  validate();
});

it("rejects malformed commands and missing open period without inference", async () => {
  const { store, stub, http, validate } = await setup();
  const run = vi.spyOn(stub, "run");
  const before = store.snapshot();
  for (const body of [{}, { text: " " }, { text: 180 }, { text: "AirPods", extra: true }]) {
    expect(await http(body)).toEqual({ status: 400, body: { error: "invalid_input" } });
  }
  expect(store.snapshot()).toEqual(before);
  delete store.state.currentPeriodId;
  expect(await http({ text: "AirPods 180" })).toEqual({ status: 409, body: { error: "no_open_period" } });
  expect(run).not.toHaveBeenCalled();
  expect(store.state.requests).toEqual(before.requests);
  validate();
});

it("rejects invalid purchase parsing and ignores an answer after reset", async () => {
  const { store, stub, submit, activity, validate } = await setup();
  vi.spyOn(stub, "run").mockResolvedValue(answer({ item: "AirPods", price: "invalid", category: "electronics" }));
  const before = store.snapshot().periods;
  const invalid = await submit();
  await vi.waitFor(() => expect(store.state.requests[invalid]!.error).toBe("invalid_parser_answer"));
  expect(store.state.requests[invalid]!.verdicts).toEqual({});
  expect(store.snapshot().periods).toEqual(before);
  let release!: (output: InferenceOutput) => void;
  vi.mocked(stub.run).mockReturnValue(new Promise(resolve => { release = resolve; }));
  const late = await submit();
  store.reset("2026-11-26");
  const reset = store.snapshot();
  release(answer({ item: "AirPods", price: 18000, category: "electronics" }));
  await vi.waitFor(() => expect(activity(late).some(e => e.phase === "answered")).toBe(true));
  expect(store.snapshot()).toEqual(reset);
  validate();
});

it("fails a purchase without a stated price instead of judging a €0.00 guess", async () => {
  const { store, stub, submit, validate } = await setup();
  const run = vi.spyOn(stub, "run").mockResolvedValue(answer({ item: "coffee machine", price: 0, category: "" }));
  const id = await submit("Can I buy a coffee machine?");
  await vi.waitFor(() => expect(store.state.requests[id]!.error).toBe("missing_amount"));
  expect(store.state.requests[id]!.verdicts).toEqual({});
  expect(run).toHaveBeenCalledOnce();
  validate();
});

it("isolates simultaneous purchase requests and their loops", async () => {
  const { store, stub, submit, activity, validate } = await setup();
  const inference = vi.spyOn(stub, "run");
  const ids = await Promise.all([submit("Can I buy AirPods for €180.00?"), submit("Can I buy Laptop for €900.00?")]);
  await Promise.all(ids.map(id => judged(store, id)));
  for (const id of ids) {
    expect(Object.keys(store.state.requests[id]!.verdicts).sort()).toEqual([...advisers].sort());
    expect(activity(id).filter(e => e.phase === "received")).toHaveLength(6);
    for (const name of ["ObligationsVerdict", "AlternativesVerdict"]) {
      const contexts = inference.mock.calls.filter(([input]) => input.structuredOutput?.name === name)
        .map(([input]) => agentContext(input) as { requestId: string });
      expect(contexts.filter(context => context.requestId === id)).toContainEqual(expect.objectContaining({
        simulation: formatMoneyFields(store.state.requests[id]!.simulation),
        purchase: formatMoneyFields(store.state.requests[id]!.parsed),
      }));
    }
  }
  expect(store.state.requests[ids[0]!]!.input).toBe("Can I buy AirPods for €180.00?");
  expect(store.state.requests[ids[1]!]!.input).toBe("Can I buy Laptop for €900.00?");
  const loops = new Set(activity(ids[0]!).map(e => e.loopId));
  expect(activity(ids[1]!).some(e => loops.has(e.loopId))).toBe(false);
  validate();
});

it("isolates simultaneous salary and purchase loops through shared Parser and Obligations", async () => {
  const { store, submit, http, activity, validate } = await setup();
  const [purchaseId, salary] = await Promise.all([submit(), http({ text: "Salary 2500 euros" }, "/api/incomes")]);
  expect(salary.status).toBe(202);
  const salaryId = AcceptedResponse.parse(salary.body).requestId;
  await judged(store, purchaseId);
  await vi.waitFor(() => {
    expect(store.state.requests[salaryId]!.verdicts.Planner).toHaveProperty("level");
    expect(store.state.requests[salaryId]!.verdicts.Obligations).toHaveProperty("level");
  }, { timeout: 4000 });
  expect(store.state.requests[salaryId]).toMatchObject({ kind: "income", parsed: { kind: "salary", amount: 250000 } });
  expect(Object.keys(store.state.requests[salaryId]!.verdicts).sort()).toEqual(["Obligations", "Planner"]);
  expect(store.state.requests[salaryId]!.judgement).toBeUndefined();
  expect(Object.keys(store.state.requests[purchaseId]!.verdicts).sort()).toEqual([...advisers].sort());
  expect(activity(salaryId).filter(e => e.agent === "Obligations" && e.phase === "received")).toHaveLength(1);
  expect(activity(purchaseId).filter(e => e.agent === "Obligations" && e.phase === "received")).toHaveLength(1);
  const loops = new Set(activity(salaryId).map(e => e.loopId));
  expect(activity(purchaseId).some(e => loops.has(e.loopId))).toBe(false);
  validate();
});

it("keeps submission simulation through delayed parsing, expenses, day and period changes", async () => {
  const { store, stub, submit, events, validate } = await setup();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-26T12:00:00Z"));
  const period = store.snapshot().periods.find(p => p.id === store.state.currentPeriodId)!;
  const expected = simulateBudget(period, "2026-11-26", { amount: 18000 });
  let releaseParser!: (value: InferenceOutput) => void;
  let releaseAdviser!: (value: InferenceOutput) => void;
  const parser = new Promise<InferenceOutput>(resolve => { releaseParser = resolve; });
  const adviser = new Promise<InferenceOutput>(resolve => { releaseAdviser = resolve; });
  // ES2023 does not expose Promise.withResolvers.
  let releaseObligations!: () => void;
  const obligationsGate = new Promise<void>(resolve => { releaseObligations = resolve; });
  const run = stub.run.bind(stub);
  const inference = vi.spyOn(stub, "run").mockImplementation(input => {
    if (input.structuredOutput?.name === "ParsedPurchase") return parser;
    if (input.structuredOutput?.name === "AlternativesVerdict") return adviser;
    if (input.structuredOutput?.name === "ObligationsVerdict") return obligationsGate.then(() => run(input));
    return run(input);
  });
  const crew = app!.get(CrewRuntime);
  const toolResults: { agent: string; result: unknown }[] = [];
  const startLoop = crew.startLoop.bind(crew);
  const obligationsResults: unknown[] = [];
  vi.spyOn(crew, "startLoop").mockImplementation((agent, id, message, schema, tools, model) => {
    const bound = tools?.map(tool => tool.type !== "function" || !["simulate_budget", "upcoming_obligations"].includes(tool.name) ? tool : {
      ...tool, invoke: async (args: unknown) => {
        const result = await tool.invoke(args);
        if (tool.name === "upcoming_obligations") obligationsResults.push(result);
        else toolResults.push({ agent: agent.getManifest().name, result });
        return result;
      },
    });
    startLoop(agent, id, message, schema, bound, model);
  });
  const sent = vi.spyOn(crew, "sendEvent");
  const id = await submit();
  await vi.waitFor(() => expect(store.state.requests[id]?.date).toBe("2026-11-26"));
  store.recordExpense({ id: "during-parser", date: "2026-11-26", amount: 1200, category: "food", note: "", source: "sim" });
  store.setToday("2026-11-27");
  releaseParser(answer({ item: "AirPods", price: 18000, category: "electronics" }));
  await vi.waitFor(() => expect(toolResults.some(value => value.agent === "Impact")).toBe(true));
  store.recordExpense({ id: "during-advisers", date: "2026-11-27", amount: 3400, category: "food", note: "", source: "sim" });
  await vi.advanceTimersByTimeAsync(86400000 * 2);
  store.setToday("2026-11-28");
  // A newly opened period must not replace the purchase's original basis either.
  store.recordIncome({ id: "new-salary", date: "2026-11-28", amount: 250000, kind: "salary", source: "salary" });
  releaseObligations();
  releaseAdviser(answer({ level: "ok", headline: "Deferred", reason: "Reviewed", figures: [] }));
  await judged(store, id);
  expect(store.state.requests[id]!.simulation).toEqual(expected);
  expect(events.find(event => event.type === "purchase.parsed" && event.data.requestId === id)).toMatchObject({
    data: { simulation: expected },
  });
  const ready = sent.mock.calls.find(([event]) => event.type === "purchase.ready")![0];
  expect(ready.payload).toMatchObject({ requestId: id, simulation: expected });
  expect(toolResults).toEqual([
    { agent: "Impact", result: formatMoneyFields(expected) },
    { agent: "Judge", result: formatMoneyFields(expected) },
  ]);
  const obligations = upcomingObligations(period, "2026-11-26", 30);
  expect(obligationsResults).toEqual([formatMoneyFields({
    ...obligations, remaining: expected.remaining.before,
    remainingAfterObligations: expected.remaining.before - obligations.total,
  })]);
  for (const name of ["ObligationsVerdict", "AlternativesVerdict"]) {
    const calls = inference.mock.calls.filter(([input]) => input.structuredOutput?.name === name);
    expect(calls.length).toBeGreaterThan(0);
    for (const [input] of calls) {
      expect(agentContext(input)).toMatchObject({
        requestId: id, purchase: { price: "€180.00" }, simulation: formatMoneyFields(expected),
        obligationsCoverage: formatMoneyFields({
          horizonDays: 30, total: obligations.total,
          remainingAfterPurchaseAndObligations: expected.remaining.after - obligations.total,
          weekAllowance: expected.todayAllowance.before * 7,
          level: expected.remaining.after - obligations.total < 0 ? "stop"
            : expected.remaining.after - obligations.total < expected.todayAllowance.before * 7 ? "warn" : "ok",
        }),
      });
    }
  }
  validate();
});

it.each([
  { price: 22000, level: "ok", margin: "€70.00" },
  { price: 22001, level: "warn", margin: "€69.99" },
  { price: 29000, level: "warn", margin: "€0.00" },
  { price: 29001, level: "stop", margin: "-€0.01" },
])("supplies conservative obligations coverage for price $price", async ({ price, level, margin }) => {
  const { store, stub, submit, validate } = await setup();
  const period = openPeriod({
    name: "Synthetic", currency: "EUR", payday: 1,
    recurringArticles: [{ name: "Bill", amount: 1000, dueDay: 2 }],
  }, { id: "salary", date: "2026-11-01", amount: 31000, kind: "salary", source: "synthetic" }, 0);
  store.state.periods = [period];
  store.state.currentPeriodId = period.id;
  store.setToday("2026-11-01");
  const inference = vi.spyOn(stub, "run");
  const id = await submit(`Can I buy Laptop for €${(price / 100).toFixed(2)}?`);
  await judged(store, id);
  const call = inference.mock.calls.find(([input]) => input.structuredOutput?.name === "ObligationsVerdict")!;
  expect(agentContext(call[0])).toMatchObject({
    obligationsCoverage: { total: "€10.00", weekAllowance: "€70.00", remainingAfterPurchaseAndObligations: margin, level },
  });
  validate();
});
