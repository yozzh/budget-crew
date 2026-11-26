import "reflect-metadata";
import { request } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { UserMessageItem, type InferenceRunner } from "@mozaik-ai/core";
import { AcceptedResponse, StateEnvelope, StateResponse } from "@budget-crew/shared";
import { afterEach, expect, it, vi } from "vitest";
import { CrewModule } from "./crew.module.js";
import { Simulator } from "./simulator.js";
import { BudgetStore } from "../budget/budget.store.js";
import { InferenceService } from "../inference/inference.module.js";
import { LIVE_INFERENCE_RUNNER } from "../inference/live-inference.runner.js";
import { StubInferenceRunner } from "../inference/stub-inference.runner.js";
import { CentrifugoPublisher } from "../realtime/centrifugo.publisher.js";

// Remove only synthetic inference latency; runtime handlers and tool loops still execute normally.
vi.mock("node:timers/promises", () => ({ setTimeout: async () => undefined }));
let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup(mode = "live", daily = "300") {
  vi.stubEnv("PUBLIC_DEMO", "true");
  vi.stubEnv("INFERENCE", mode);
  vi.stubEnv("OPENAI_API_KEY", "test-not-a-real-key");
  vi.stubEnv("MOZAIK_API_KEY", "");
  vi.stubEnv("LIVE_LIMIT_PER_IP_PER_HOUR", "10");
  vi.stubEnv("LIVE_LIMIT_PER_DAY", daily);
  const search = vi.fn(async (url: string, options: RequestInit) => {
    // No network escapes this test, including telemetry/cloud calls.
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(JSON.parse(options.body as string)).toHaveProperty("tools.0.type", "web_search");
    return { ok: true, json: async () => ({ output: [{ type: "message", content: [{
      type: "output_text", text: "Synthetic test price EUR 80.00", annotations: [],
    }] }] }) };
  });
  vi.stubGlobal("fetch", search);
  const events: StateEnvelope[] = [];
  vi.spyOn(CentrifugoPublisher.prototype, "publish").mockImplementation(async (channel, envelope) => {
    if (channel === "crew:state") events.push(StateEnvelope.parse(envelope));
  });
  app = await NestFactory.create(CrewModule, { logger: false });
  const stub = app.get(StubInferenceRunner);
  const live = app.get<InferenceRunner>(LIVE_INFERENCE_RUNNER);
  const liveRun = vi.fn<InferenceRunner["run"]>(input => stub.run(input));
  if (live !== stub) vi.spyOn(live, "run").mockImplementation(liveRun);
  app.setGlobalPrefix("api");
  await app.listen(25500, "127.0.0.1");
  const store = app.get(BudgetStore);
  store.reset("2026-11-26");
  // ES2023 is the repository compile-time library; Promise.withResolvers is unavailable.
  const http = (body?: unknown, path = "/api/purchase-checks", ip = "198.51.100.1"): Promise<{ status: number; body: unknown }> => new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: 25500, path, method: body === undefined ? "GET" : "POST",
      agent: false, headers: { "content-type": "application/json", "x-forwarded-for": ip } }, res => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(data) as unknown }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const submit = async (text = "Can I buy a jacket for 90?", ip?: string) => {
    const response = await http({ text }, undefined, ip);
    expect(response.status).toBe(202);
    return AcceptedResponse.parse(response.body).requestId;
  };
  const complete = async (ids: string[]) => {
    await vi.waitFor(() => {
      for (const id of ids) expect(store.state.requests[id]?.judgement).toHaveProperty("decision");
    }, { timeout: 2000, interval: 5 });
  };
  return { store, liveRun, search, events, http, submit, complete };
}

it("runs ten accepted purchases live, routes the eleventh offline, and isolates concurrent IPs", async () => {
  const { store, liveRun, search, events, http, submit, complete } = await setup();
  expect((await http({ text: " " })).status).toBe(400);
  expect((await http({ text: "jacket 90", source: "sim" })).status).toBe(400);
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) ids.push(await submit());
  const limited = await submit("Can I buy a blocked jacket for 90?");
  const other = await submit("Can I buy another jacket for 90?", "198.51.100.2");
  await complete([...ids, limited, other]);
  for (const id of [...ids, other]) expect(store.state.requests[id]?.inference).toEqual({ mode: "live" });
  expect(store.state.requests[limited]).toMatchObject({ inference: { mode: "stub", reason: "limit" }, parsed: { item: "blocked jacket", price: 9000 } });
  const liveIds = new Set(liveRun.mock.calls.map(([input]) => {
    const message = input.context.items.find(item => item instanceof UserMessageItem) as UserMessageItem;
    return /^\[req:([^\]]+)\]/.exec(message.content.text)?.[1];
  }));
  expect(liveIds).toEqual(new Set([...ids, other]));
  expect(search).toHaveBeenCalledTimes(22);
  expect(search.mock.calls.every(([, options]) => !(options.body as string).includes("blocked jacket"))).toBe(true);
  const snapshot = StateResponse.parse((await http(undefined, "/api/state")).body);
  expect(snapshot.requests[limited]?.inference).toEqual({ mode: "stub", reason: "limit" });
  const publications = events.filter(e => "requestId" in e.data && e.data.requestId === limited);
  expect(publications.some(e => e.type === "purchase.judged")).toBe(true);
  for (const event of publications) expect(event.data).toHaveProperty("inference", { mode: "stub", reason: "limit" });
  // A budget reset must not refund the paid usage quota.
  store.reset("2026-11-26");
  const afterReset = await submit();
  await complete([afterReset]);
  expect(store.state.requests[afterReset]?.inference).toEqual({ mode: "stub", reason: "limit" });
});

it.each(["live", "stub"])("routes a complete timelapse offline in %s mode without reserving human quota", async mode => {
  const { store, liveRun, search, events, submit, complete } = await setup(mode, "1");
  app!.get(Simulator).start(0.001);
  await vi.waitFor(() => {
    expect(store.state.simulation.running).toBe(false);
    const requests = Object.values(store.state.requests).filter(r => r.source === "sim");
    expect(requests.filter(r => r.kind === "expense" && r.parsed)).toHaveLength(65);
    expect(requests.filter(r => r.kind === "income" && r.parsed)).toHaveLength(2);
    expect(requests.filter(r => r.kind === "purchase" && r.judgement)).toHaveLength(4);
  }, { timeout: 2000, interval: 5 });
  for (const state of Object.values(store.state.requests).filter(r => r.source === "sim")) expect(state.inference).toEqual({ mode: "stub", reason: "replay" });
  expect(liveRun).not.toHaveBeenCalled();
  expect(search).not.toHaveBeenCalled();
  for (const event of events) if ("requestId" in event.data) expect(event.data).toHaveProperty("inference", { mode: "stub", reason: "replay" });
  const human = await submit();
  await complete([human]);
  expect(store.state.requests[human]?.inference).toEqual({ mode });
  if (mode === "live") expect(liveRun).toHaveBeenCalled();
  else expect(liveRun).not.toHaveBeenCalled();
  expect(app!.get(InferenceService).requestMode(human)).toBe(mode);
});
