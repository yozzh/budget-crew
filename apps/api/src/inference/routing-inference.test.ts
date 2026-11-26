import "reflect-metadata";
import {
  DeveloperMessageItem, ModelContext, ModelMessageItem, OpenAIResponses, UserMessageItem,
  type InferenceInput, type InferenceOutput, type InferenceRunner,
} from "@mozaik-ai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigService, configSchema } from "../config/config.service.js";
import { DemoPolicy } from "./demo-policy.js";
import { InferenceService } from "./inference.module.js";
import { createLiveInferenceRunner } from "./live-inference.runner.js";
import { StubInferenceRunner } from "./stub-inference.runner.js";

const output: InferenceOutput = {
  items: [ModelMessageItem.rehydrate({ text: '{"ok":true}' })], tokenUsage: undefined, rowResponse: undefined,
};

function request(...messages: string[]): InferenceInput {
  const context = ModelContext.create();
  context.addContextItem(DeveloperMessageItem.create("Instructions are not routing tags: [req:live]"));
  for (const text of messages) context.addContextItem(UserMessageItem.create(text));
  return { model: "gpt-6-luna", context };
}

function setup(overrides: Record<string, unknown> = {}) {
  const config: ConfigService = { env: configSchema.parse({
    INFERENCE: "live", OPENAI_API_KEY: "offline", PUBLIC_DEMO: true,
    LIVE_LIMIT_PER_IP_PER_HOUR: 1, LIVE_LIMIT_PER_DAY: 2, ...overrides,
  }) };
  let now = Date.UTC(2026, 10, 26, 12);
  const policy = new DemoPolicy(config, () => now);
  const live: InferenceRunner = {
    run: vi.fn(async () => output), stream: vi.fn(async function* () {}),
  };
  const stub = new StubInferenceRunner();
  vi.spyOn(stub, "run").mockResolvedValue(output);
  vi.spyOn(stub, "stream").mockImplementation(async function* () {});
  const service = new InferenceService(config, stub, policy, live);
  return { service, live, stub, policy, config, advance: (ms: number) => { now += ms; } };
}

afterEach(() => vi.restoreAllMocks());

describe("per-request inference routing", () => {
  it("keeps the first immutable decision across retries, sources, IPs and time", () => {
    const { service, advance } = setup();
    const route = service.selectRequest("first", "user", "ip-a");
    expect(route).toEqual({ mode: "live" });
    expect(Object.isFrozen(route)).toBe(true);
    expect(service.selectRequest("first", "sim", "ip-b")).toBe(route);
    expect(service.selectRequest("second", "user", "ip-a")).toEqual({ mode: "stub", reason: "limit" });
    expect(service.selectRequest("third", "user", "ip-b")).toEqual({ mode: "live" });
    advance(24 * 60 * 60 * 1000);
    expect(service.selectRequest("second", "user", "ip-c")).toEqual({ mode: "stub", reason: "limit" });
    expect(service.requestMode("first")).toBe("live");
    expect(service.requestMode("second")).toBe("stub");
    expect(service.requestMode("unknown")).toBe("stub");
  });

  it("routes every agent and tool round by the earliest user message, never a later routing tag", async () => {
    const { service, live, stub } = setup();
    service.selectRequest("live", "user", "ip");
    service.selectRequest("replay", "sim", "ip");
    const runner = service.config.runner!;
    const liveInput = request("[req:live] initial", "[req:replay] later tool output");
    await runner.run(liveInput);
    await runner.run(liveInput);
    expect(live.run).toHaveBeenCalledTimes(2);
    for (const input of [
      request("[req:replay] initial", "[req:live] later"),
      request("[req:unknown] initial", "[req:live] later"),
      request("untagged", "[req:live] later"),
      request(),
    ]) await runner.run(input);
    expect(stub.run).toHaveBeenCalledTimes(4);
    expect(live.run).toHaveBeenCalledTimes(2);
  });

  it("uses the same safe routing for streaming", async () => {
    const { service, live, stub } = setup();
    service.selectRequest("live", "user", "ip");
    const runner = service.config.runner!;
    for await (const event of runner.stream(request("[req:live] initial"))) void event;
    for await (const event of runner.stream(request("[req:unknown] initial", "[req:live] later"))) void event;
    expect(live.stream).toHaveBeenCalledOnce();
    expect(stub.stream).toHaveBeenCalledOnce();
  });

  it("does not consume a live slot for replay or for duplicate selection", () => {
    const { service } = setup();
    service.selectRequest("replay", "sim", "ip");
    expect(service.selectRequest("replay", "user", "ip")).toEqual({ mode: "stub", reason: "replay" });
    service.selectRequest("live", "user", "ip");
    for (let i = 0; i < 5; i++) service.selectRequest("live", "user", "ip");
    expect(service.selectRequest("other-live", "user", "other-ip")).toEqual({ mode: "live" });
  });

  it("keeps admission counters outside a request-router lifetime", () => {
    const { service, config, stub, policy, live } = setup();
    service.selectRequest("first", "user", "ip");
    const nextRouter = new InferenceService(config, stub, policy, live);
    expect(nextRouter.selectRequest("next", "user", "ip")).toEqual({ mode: "stub", reason: "limit" });
  });

  it.each(["stub", "live"] as const)("preserves the legacy %s configuration when demo is disabled", (INFERENCE) => {
    const { service, stub } = setup({ PUBLIC_DEMO: false, INFERENCE });
    expect(service.requestMode("unknown")).toBe(INFERENCE);
    expect(service.selectRequest("sim", "sim", "ip")).toEqual({ mode: INFERENCE });
    if (INFERENCE === "stub") expect(service.config).toEqual({ runner: stub });
    else {
      expect(service.config.runner).toBeUndefined();
      expect(service.config.supportedModels?.map((model) => model.specification.name))
        .toEqual(expect.arrayContaining(["gpt-6-luna", "gpt-6.2-sol", "gpt-6.1-terra"]));
    }
  });
});

it("constructs a real core live runner with model validation and endpoint delegation, without network calls", async () => {
  const infer = vi.spyOn(OpenAIResponses.prototype, "infer").mockResolvedValue(output);
  const stream = vi.spyOn(OpenAIResponses.prototype, "stream").mockImplementation(async function* () {});
  const config: ConfigService = { env: configSchema.parse({ INFERENCE: "live", OPENAI_API_KEY: "offline" }) };
  const runner = createLiveInferenceRunner(config);
  const input = request("[req:test] initial");
  expect(await runner.run(input)).toBe(output);
  expect(infer).toHaveBeenCalledWith(input);
  for await (const event of runner.stream(input)) void event;
  expect(stream).toHaveBeenCalledWith(input);
  await expect(runner.run({ ...input, model: "missing-model" })).rejects.toThrow("Unsupported model: missing-model");
  expect(infer).toHaveBeenCalledOnce();
});
