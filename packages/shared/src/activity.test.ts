import { expect, it } from "vitest";
import { ActivityEnvelope, AgentName } from "./index.js";

const activity = {
  v: 1,
  type: "agent.activity",
  at: "2026-11-26T12:00:00.000Z",
  data: { agent: "Impact", loopId: "loop", phase: "thinking" },
};

it("accepts all agent names and activity phases with optional request/tool/summary fields", () => {
  expect(ActivityEnvelope.parse(activity)).toEqual(activity);
  for (const agent of AgentName.options) {
    for (const phase of ["received", "thinking", "tool", "answered", "failed"]) {
      const publication = {
        ...activity,
        data: { agent, loopId: "loop", requestId: "req", phase, tool: "simulate_budget", summary: "Checking the budget" },
      };
      expect(ActivityEnvelope.parse(publication)).toEqual(publication);
    }
  }
});

it("limits summaries to 120 characters", () => {
  expect(ActivityEnvelope.safeParse({ ...activity, data: { ...activity.data, summary: "x".repeat(120) } }).success).toBe(true);
  expect(ActivityEnvelope.safeParse({ ...activity, data: { ...activity.data, summary: "x".repeat(121) } }).success).toBe(false);
});

it("rejects malformed envelope headers, activity fields and unknown properties", () => {
  for (const publication of [
    { ...activity, v: 2 },
    { ...activity, type: "agent.thinking" },
    { ...activity, at: "2026-11-26" },
    { ...activity, extra: true },
    { ...activity, data: { ...activity.data, agent: "Ledger" } },
    { ...activity, data: { ...activity.data, phase: "running" } },
    { ...activity, data: { agent: "Impact", phase: "thinking" } },
    { ...activity, data: { agent: "Impact", loopId: "loop" } },
    { ...activity, data: { ...activity.data, prompt: "Private prompt" } },
    { ...activity, data: { ...activity.data, summary: 42 } },
  ]) {
    expect(ActivityEnvelope.safeParse(publication).success).toBe(false);
  }
});
