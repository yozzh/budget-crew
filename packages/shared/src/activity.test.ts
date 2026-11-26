import { describe, expect, it } from "vitest";
import { ActivityEnvelope } from "./activity.js";

describe("activity schema", () => {
  const valid = { v: 1, type: "agent.activity", at: "2026-01-01T00:00:00.000Z", data: { agent: "Analyst", loopId: "a", phase: "failed" } };
  it("validates the version, timestamp, phases and summary limit", () => {
    expect(ActivityEnvelope.safeParse(valid).success).toBe(true);
    for (const phase of ["received", "thinking", "tool", "answered", "failed"]) {
      expect(ActivityEnvelope.safeParse({ ...valid, data: { ...valid.data, phase } }).success).toBe(true);
    }
    for (const invalid of [
      { ...valid, v: 2 },
      { ...valid, type: "other" },
      { ...valid, at: "today" },
      { ...valid, data: { ...valid.data, phase: "other" } },
      { ...valid, data: { ...valid.data, summary: "x".repeat(121) } },
    ]) expect(ActivityEnvelope.safeParse(invalid).success).toBe(false);
    expect(ActivityEnvelope.safeParse({ ...valid, data: { ...valid.data, summary: "x".repeat(120) } }).success).toBe(true);
  });
});
