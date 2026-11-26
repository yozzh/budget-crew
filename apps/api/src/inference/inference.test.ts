import { defineRuntime, FunctionCallItem, ModelContext, ModelMessageItem, UserMessageItem } from "@mozaik-ai/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BudgetState } from "../budget/budget.store.js";
import { createSupportedModels } from "./models.js";
import { StubInferenceRunner } from "./stub-inference.runner.js";

it.each(["gpt-6.2-sol", "gpt-6.1-terra"])("validates live model %s through core without a network endpoint", async (model) => {
  const models = createSupportedModels("offline");
  const luna = models.find((m) => m.specification.name === "gpt-6-luna")!;
  const selected = models.find((m) => m.specification.name === model)!;
  expect(selected.specification).toEqual({ ...luna.specification, name: model });
  const infer = vi.fn(async () => ({ items: [ModelMessageItem.rehydrate({ text: '{"ok":true}' })], tokenUsage: undefined, rowResponse: undefined }));
  const runtime = defineRuntime<BudgetState>().initializeRuntime({ state: new BudgetState(), inferenceRunnerConfig: {
    supportedModels: models.map((m) => ({ ...m, endpoint: { infer, endpointMapper: m.endpoint.endpointMapper,
      async *stream() { yield await Promise.reject(new Error("Unexpected streaming")); },
    } })),
  } });
  const result = await runtime.getInferenceRunner().run({ model, context: ModelContext.create(), structuredOutput: {
    name: "LiveValidation", strict: true, schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
  } });
  expect(result.items[0]).toBeInstanceOf(ModelMessageItem);
  expect(infer).toHaveBeenCalledOnce();
});

describe("StubInferenceRunner fixtures", () => {
  it("rejects unknown schemas and invalid fixtures rather than returning fake output", async () => {
    const stub = new StubInferenceRunner();
    expect(() => stub.registerFixture("Answer", z.object({ count: z.number() }), { count: "bad" })).toThrow();
    await expect(stub.run({ model: "gpt-6-luna", context: ModelContext.create(), structuredOutput: { name: "Missing", schema: {} } }))
      .rejects.toThrow("No stub fixture for schema: Missing");
  });

  it.each([
    { schema: "ImpactVerdict", tool: "simulate_budget", purchase: { item: "Laptop", price: "€1,234.56" }, nested: true, args: { amount: "€1,234.56" } },
    { schema: "Judgement", tool: "simulate_budget", purchase: { item: "Laptop", price: "€1,234.56" }, nested: true, args: { amount: "€1,234.56" } },
    { schema: "DealCheckVerdict", tool: "price_history", purchase: { item: "Laptop", price: "€1,234.56" }, nested: false, args: { item: "Laptop" } },
    { schema: "AlternativesVerdict", tool: "web_search", purchase: { item: "Laptop", price: "€1,234.56" }, nested: true, args: { query: "Laptop cheaper alternatives EUR" } },
  ])("copies displayed purchase values into $schema tool arguments", async ({ schema, tool, purchase, nested, args }) => {
    const stub = new StubInferenceRunner();
    const context = ModelContext.create();
    context.addContextItem(UserMessageItem.create(`[req:purchase] ${JSON.stringify(nested ? { purchase } : purchase)}`));
    const invoke = vi.fn(async () => undefined);
    const result = await stub.run({
      model: "gpt-6-luna", context, structuredOutput: { name: schema, schema: {} },
      tools: [{ type: "function", name: tool, description: "Offline test tool", parameters: {}, strict: true, invoke }],
    });
    expect(result.items[0]).toBeInstanceOf(FunctionCallItem);
    const call = result.items[0] as FunctionCallItem;
    expect(call.name).toBe(tool);
    expect(JSON.parse(call.args)).toEqual(args);
    expect(purchase.price).toBe("€1,234.56");
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(["ImpactVerdict", "Judgement"])("uses a euro string in the default %s simulation fixture", async (schema) => {
    const result = await new StubInferenceRunner().run({
      model: "gpt-6-luna", context: ModelContext.create(), structuredOutput: { name: schema, schema: {} },
      tools: [{ type: "function", name: "simulate_budget", description: "Offline test tool", parameters: {}, strict: true, invoke: vi.fn() }],
    });
    expect(JSON.parse((result.items[0] as FunctionCallItem).args)).toEqual({ amount: "€180.00" });
  });

  it("advances Deal Check through history and search using only the current context", async () => {
    const stub = new StubInferenceRunner();
    const context = ModelContext.create();
    context.addContextItem(UserMessageItem.create('[req:purchase] {"item":"AirPods Pro 3","price":"€179.00"}'));
    const invoke = vi.fn();
    const input = {
      model: "gpt-6-luna", context, structuredOutput: { name: "DealCheckVerdict", schema: {} },
      tools: ["price_history", "web_search"].map(name => ({
        type: "function" as const, name, description: "Offline test tool", parameters: {}, strict: true, invoke,
      })),
    };
    const history = (await stub.run(input)).items[0] as FunctionCallItem;
    expect(history).toBeInstanceOf(FunctionCallItem);
    expect(history.name).toBe("price_history");
    expect(JSON.parse(history.args)).toEqual({ item: "AirPods Pro 3" });
    context.addContextItem(history);
    const search = (await stub.run(input)).items[0] as FunctionCallItem;
    expect(search).toBeInstanceOf(FunctionCallItem);
    expect(search.name).toBe("web_search");
    expect(JSON.parse(search.args)).toEqual({ query: "AirPods Pro 3 current price EUR" });
    context.addContextItem(search);
    const answer = (await stub.run(input)).items[0] as ModelMessageItem;
    expect(answer).toBeInstanceOf(ModelMessageItem);
    expect(JSON.parse(answer.content.text)).toMatchObject({
      reason: expect.stringMatching(/offline synthetic.*not live/i),
      figures: [{ label: "Source", value: expect.stringMatching(/\.example €149\.00$/) }],
    });
    expect((await stub.run({ ...input, context: ModelContext.create() })).items[0]).toMatchObject({ name: "price_history" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects a missing tool at the next sequence step rather than skipping it", async () => {
    const stub = new StubInferenceRunner();
    const context = ModelContext.create();
    context.addContextItem(FunctionCallItem.rehydrate({ callId: "history", name: "price_history", args: "{}" }));
    await expect(stub.run({
      model: "gpt-6-luna", context, structuredOutput: { name: "DealCheckVerdict", schema: {} },
    })).rejects.toThrow("Stub fixture requests unavailable tool: web_search");
  });

  it("preserves registered single-call fixtures and completes after their call", async () => {
    const stub = new StubInferenceRunner();
    const schema = z.object({ answer: z.string() });
    stub.registerFixture("Single", schema, { answer: "done" }, { name: "snapshot", args: { day: 1 } });
    const context = ModelContext.create();
    const input = {
      model: "gpt-6-luna", context, structuredOutput: { name: "Single", schema: {} },
      tools: [{ type: "function" as const, name: "snapshot", description: "Offline test tool", parameters: {}, strict: true, invoke: vi.fn() }],
    };
    const call = (await stub.run(input)).items[0] as FunctionCallItem;
    expect(call).toBeInstanceOf(FunctionCallItem);
    expect(call.name).toBe("snapshot");
    expect(JSON.parse(call.args)).toEqual({ day: 1 });
    context.addContextItem(call);
    const answer = (await stub.run(input)).items[0] as ModelMessageItem;
    expect(answer).toBeInstanceOf(ModelMessageItem);
    expect(JSON.parse(answer.content.text)).toEqual({ answer: "done" });
  });

  it("completes Alternatives after its default search with an explicitly synthetic source", async () => {
    const stub = new StubInferenceRunner();
    const context = ModelContext.create();
    const input = {
      model: "gpt-6-luna", context, structuredOutput: { name: "AlternativesVerdict", schema: {} },
      tools: [{ type: "function" as const, name: "web_search", description: "Offline test tool", parameters: {}, strict: true, invoke: vi.fn() }],
    };
    const call = (await stub.run(input)).items[0] as FunctionCallItem;
    expect(call).toBeInstanceOf(FunctionCallItem);
    expect(call.name).toBe("web_search");
    expect(JSON.parse(call.args)).toEqual({ query: "AirPods cheaper alternatives EUR" });
    context.addContextItem(call);
    const answer = (await stub.run(input)).items[0] as ModelMessageItem;
    expect(answer).toBeInstanceOf(ModelMessageItem);
    expect(JSON.parse(answer.content.text)).toMatchObject({
      reason: expect.stringMatching(/offline synthetic.*not live/i),
      figures: [{ label: "Source", value: "shop.example €149.00" }],
    });
  });
});
