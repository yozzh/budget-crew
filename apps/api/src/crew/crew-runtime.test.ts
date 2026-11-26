import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  createAgent, createHuman, SemanticEvent, SituationSpecification,
  type SituationContext, type InferenceInput, UserMessageItem,
} from "@mozaik-ai/core";
import { ActivityEnvelope } from "@budget-crew/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CrewModule } from "./crew.module.js";
import { CrewRuntime } from "./crew-runtime.js";
import { StubInferenceRunner } from "../inference/stub-inference.runner.js";
import { CentrifugoPublisher } from "../realtime/centrifugo.publisher.js";
import { BudgetStore } from "../budget/budget.store.js";

const output = z.object({ result: z.literal("ok") });
const schema = { name: "TestAnswer", schema: z.toJSONSchema(output), strict: true };
class Submitted extends SituationSpecification {
  isSatisfiedBy({ event }: SituationContext): boolean { return event.type === "test.submitted"; }
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function setup() {
  vi.stubEnv("INFERENCE", "stub");
  vi.stubEnv("MOZAIK_API_KEY", "must-never-connect");
  vi.stubEnv("OPENAI_API_KEY", "must-never-connect");
  const network = vi.fn(() => { throw new Error("Network forbidden"); });
  vi.stubGlobal("fetch", network);
  const publications: { channel: string; envelope: ActivityEnvelope }[] = [];
  vi.spyOn(CentrifugoPublisher.prototype, "publish").mockImplementation(async (channel, envelope) => {
    if (envelope.type === "agent.activity") publications.push({ channel, envelope });
  });
  const app = await NestFactory.createApplicationContext(CrewModule, { logger: false });
  const crew = app.get(CrewRuntime);
  const stub = app.get(StubInferenceRunner);
  stub.registerFixture(schema.name, output, { result: "ok" });
  return { app, crew, stub, publications, network };
}

describe("CrewRuntime", () => {
  it("records runtime events in the seeded store before and after reset without losing participants", async () => {
    const { app, crew, network } = await setup();
    try {
      const store = app.get(BudgetStore);
      store.reset("2026-11-26");
      const ledger = createHuman({ name: "Ledger", capabilities: [], handlers: [{
        specification: new Submitted(),
        processor: { apply() {
          store.recordExpense({ id: "event-expense", requestId: "event-request", date: crew.state.today,
            amount: 100, category: "food", note: crew.state.profile.name, source: "user" });
        } },
      }] });
      const human = createHuman({ name: "Human", capabilities: [], handlers: [] });
      crew.join(ledger);
      crew.join(human);
      for (let round = 0; round < 2; round++) {
        if (round === 1) store.reset("2026-11-26");
        crew.sendEvent(SemanticEvent.create("test.submitted", human.getId(), {}), human.getId());
        await vi.waitFor(() => {
          const snapshot = store.snapshot();
          const period = snapshot.periods.find(period => period.id === snapshot.currentPeriodId)!;
          expect(period.expenses.at(-1)).toMatchObject({ id: "event-expense", note: "Alex" });
          expect(period.expenses).toHaveLength(4);
          expect(crew.state.requests["event-request"]!.parsed).toMatchObject({ amount: 100 });
        });
      }
      expect(network).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("starts two agents from one event, overlaps loops and correlates every activity without network", async () => {
    const { app, crew, publications, network } = await setup();
    try {
      for (const name of ["First", "Second"]) {
        const agent = createAgent({ name, instruction: "Return a test answer", tools: [], capabilities: [], handlers: [{
          specification: new Submitted(), processor: { apply() { crew.startLoop(agent, "request-1", "private prompt", schema); } },
        }] });
        crew.join(agent);
      }
      const human = createHuman({ name: "Human", capabilities: [], handlers: [] });
      crew.join(human);
      crew.sendEvent(SemanticEvent.create("test.submitted", human.getId(), {}), human.getId());
      await vi.waitFor(() => expect(publications.filter((p) => p.envelope.data.phase === "answered")).toHaveLength(2));
      const phases = publications.map((p) => p.envelope.data.phase);
      expect(phases.lastIndexOf("received")).toBeLessThan(phases.indexOf("answered"));
      expect(new Set(publications.map((p) => p.envelope.data.loopId)).size).toBe(2);
      expect(new Set(publications.map((p) => p.envelope.data.agent))).toEqual(new Set(["First", "Second"]));
      for (const { channel, envelope } of publications) {
        expect(channel).toBe("crew:activity");
        expect(ActivityEnvelope.parse(envelope).data.requestId).toBe("request-1");
        expect(envelope.data.summary ?? "").not.toContain("private prompt");
      }
      expect(network).not.toHaveBeenCalled();
      expect(process.env.MOZAIK_API_KEY).toBe("must-never-connect");
    } finally { await app.close(); }
  });

  it("isolates two concurrent loops of the same agent and leaves its memory untouched", async () => {
    const { app, crew, stub, publications, network } = await setup();
    try {
      const contexts: InferenceInput[] = [];
      const run = stub.run.bind(stub);
      vi.spyOn(stub, "run").mockImplementation((input) => { contexts.push(input); return run(input); });
      const agent = createAgent({ name: "Same", instruction: "developer instruction", tools: [], capabilities: [], handlers: [] });
      crew.join(agent);
      crew.startLoop(agent, "a", "alpha", schema);
      crew.startLoop(agent, "b", "beta", schema);
      await vi.waitFor(() => expect(publications.filter((p) => p.envelope.data.phase === "answered")).toHaveLength(2));
      expect(contexts[0]!.context).not.toBe(contexts[1]!.context);
      expect(contexts.map((input) => input.context.items.filter((item) => item instanceof UserMessageItem).map((item) => item.content.text)))
        .toEqual([["[req:a] alpha"], ["[req:b] beta"]]);
      expect(agent.getMemory().getContext().items.some((item) => item instanceof UserMessageItem)).toBe(false);
      expect(publications.filter((p) => p.envelope.data.phase === "answered").map((p) => p.envelope.data.requestId).sort()).toEqual(["a", "b"]);
      expect(network).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("executes the optional tool once and publishes correlated tool activity before the answer", async () => {
    const { app, crew, stub, publications, network } = await setup();
    try {
      const invoke = vi.fn(async () => ({ allowance: 10 }));
      stub.registerFixture(schema.name, output, { result: "ok" }, { name: "snapshot", args: {} });
      const agent = createAgent({ name: "Tools", instruction: "Use snapshot", capabilities: [], handlers: [], tools: [{
        type: "function", name: "snapshot", description: "Read budget", strict: true,
        parameters: { type: "object", properties: {}, additionalProperties: false }, invoke,
      }] });
      crew.join(agent);
      crew.startLoop(agent, "tool-request", "private input", schema);
      await vi.waitFor(() => expect(publications.at(-1)?.envelope.data.phase).toBe("answered"));
      expect(invoke).toHaveBeenCalledExactlyOnceWith({});
      const tool = publications.find((p) => p.envelope.data.phase === "tool")!.envelope;
      expect(ActivityEnvelope.parse(tool).data).toMatchObject({ requestId: "tool-request", tool: "snapshot" });
      expect(network).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
