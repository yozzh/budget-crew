import "reflect-metadata";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ModelMessageItem, type InferenceOutput } from "@mozaik-ai/core";
import { AcceptedResponse, ActivityEnvelope, StateEnvelope } from "@budget-crew/shared";
import { afterEach, expect, it, vi } from "vitest";
import { BudgetStore } from "../budget/budget.store.js";
import { StubInferenceRunner } from "../inference/stub-inference.runner.js";
import { CentrifugoPublisher } from "../realtime/centrifugo.publisher.js";
import { CrewModule } from "./crew.module.js";

const advisers = ["Impact", "Obligations", "Deal Check", "Alternatives"] as const;
let app: INestApplication | undefined;
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
  const { store, submit, activity, events, validate } = await setup();
  const before = store.snapshot().periods;
  const id = await submit();
  await judged(store, id);
  const state = store.state.requests[id]!;
  expect(state).toMatchObject({ kind: "purchase", parsed: { item: "AirPods", price: 18000 } });
  expect(Object.keys(state.verdicts).sort()).toEqual([...advisers].sort());
  expect(store.snapshot().periods).toEqual(before);
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
  validate();
});

it("fills a missing adviser at 45 seconds, judges once and ignores its late answer", async () => {
  const { store, stub, submit, activity, validate } = await setup();
  const run = stub.run.bind(stub);
  let release!: (output: InferenceOutput) => void;
  const pending = new Promise<InferenceOutput>(resolve => { release = resolve; });
  vi.spyOn(stub, "run").mockImplementation(input => input.structuredOutput?.name === "AlternativesVerdict" ? pending : run(input));
  const nativeTimeout = globalThis.setTimeout;
  const deadlines: { timer: NodeJS.Timeout; expire: () => void }[] = [];
  const timeout = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
    const timer = nativeTimeout(callback, delay, ...args);
    if (delay === 45000) deadlines.push({ timer, expire: () => callback(...args) });
    return timer;
  });
  const id = await submit();
  await vi.waitFor(() => expect(Object.keys(store.state.requests[id]!.verdicts)).toHaveLength(3), { timeout: 3000 });
  expect(store.state.requests[id]!.judgement).toBeUndefined();
  for (const { timer } of deadlines) clearTimeout(timer);
  timeout.mockRestore();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  for (const { expire } of deadlines) setTimeout(expire, 45000);
  await vi.advanceTimersByTimeAsync(44999);
  expect(store.state.requests[id]!.verdicts.Alternatives).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(store.state.requests[id]!.verdicts.Alternatives).toEqual({ status: "failed", error: "timeout" });
  vi.useRealTimers();
  await judged(store, id);
  release(answer({ level: "ok", headline: "Late", reason: "Late", figures: [] }));
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
  expect(store.state.requests).toEqual({});
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

it("isolates simultaneous purchase requests and their loops", async () => {
  const { store, submit, activity, validate } = await setup();
  const ids = await Promise.all([submit("first purchase"), submit("second purchase")]);
  await Promise.all(ids.map(id => judged(store, id)));
  for (const id of ids) {
    expect(Object.keys(store.state.requests[id]!.verdicts).sort()).toEqual([...advisers].sort());
    expect(activity(id).filter(e => e.phase === "received")).toHaveLength(6);
  }
  expect(store.state.requests[ids[0]!]!.input).toBe("first purchase");
  expect(store.state.requests[ids[1]!]!.input).toBe("second purchase");
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
