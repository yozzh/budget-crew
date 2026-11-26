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
});
