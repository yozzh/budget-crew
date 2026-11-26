import { describe, expect, it } from "vitest";
import { AgentName, type ActivityEnvelope, type StateResponse } from "@budget-crew/shared";
import { applyEnvelope, initialModel, SnapshotSync, type ViewModel } from "./model.js";
import { deriveTimeline } from "./timeline.js";

const epoch = Date.parse("2026-11-26T12:00:00Z");
function event(ms: number, phase: ActivityEnvelope["data"]["phase"], loopId = "one", agent = "Pace", requestId: string | undefined = "req"): ActivityEnvelope {
  return { v: 1, at: new Date(epoch + ms).toISOString(), type: "agent.activity", data: { agent, loopId, requestId, phase } };
}
function apply(...events: ActivityEnvelope[]): ViewModel {
  return events.reduce(applyEnvelope, { ...initialModel });
}
function completed(start: number, end: number, loopId: string, agent = "Pace", requestId = "req"): ActivityEnvelope[] {
  return [event(start, "received", loopId, agent, requestId), event(end, "answered", loopId, agent, requestId)];
}
function bars(model: ViewModel, now = 100, requestId = "req") {
  return deriveTimeline(model, requestId, epoch + now).lanes.flatMap((lane) => lane.bars);
}
const snapshot: StateResponse = {
  profile: { name: "Demo", currency: "EUR", payday: 1, recurringArticles: [] },
  today: "2026-11-26", periods: [], requests: {}, simulation: { running: false, speed: 1 },
};

describe("agent swimlanes", () => {
  it("keeps ten lanes in crew order, including idle agents", () => {
    const timeline = deriveTimeline(initialModel, undefined, epoch);
    expect(timeline.lanes.map((lane) => lane.agent)).toEqual(AgentName.options);
    expect(timeline.lanes.every((lane) => lane.bars.length === 0 && lane.rows === 1)).toBe(true);
    expect(timeline).toMatchObject({ start: epoch, end: epoch, running: 0, peak: 0 });
  });

  it("stacks overlapping loops, reuses rows at touching endpoints, and counts actual overlap", () => {
    const model = apply(...completed(0, 100, "one"), ...completed(20, 60, "two"),
      ...completed(60, 80, "three"), ...completed(40, 80, "coach", "Coach"));
    const timeline = deriveTimeline(model, "req", epoch + 200);
    const pace = timeline.lanes.find((lane) => lane.agent === "Pace")!;
    expect(pace.rows).toBe(2);
    expect(pace.bars.map((bar) => [bar.loopId, bar.row])).toEqual([["one", 0], ["two", 1], ["three", 1]]);
    expect(timeline).toMatchObject({ start: epoch, end: epoch + 100, peak: 3, running: 0 });
  });

  it("does not count serial or instantaneous loops as concurrent", () => {
    const model = apply(...completed(0, 20, "one"), ...completed(20, 40, "two"), ...completed(20, 20, "instant"));
    expect(deriveTimeline(model, "req", epoch + 100).peak).toBe(1);
    expect(deriveTimeline(apply(...completed(10, 10, "instant")), "req", epoch + 100))
      .toMatchObject({ start: epoch + 10, end: epoch + 10, peak: 0 });
  });

  it("windows all requests, clips old running loops, drops expired loops and highlights only the latest", () => {
    const model = apply(...completed(0, 10_000, "expired"), ...completed(5_000, 15_000, "clipped"),
      event(1_000, "received", "old-running", "Coach", "old"),
      ...completed(12_000, 19_000, "previous", "Pace", "previous"),
      event(25_000, "thinking", "new", "Pace", "latest"),
      event(31_000, "received", "future"));
    const timeline = deriveTimeline(model, "latest", epoch + 30_000, true);
    expect(timeline).toMatchObject({ start: epoch + 10_000, end: epoch + 30_000, running: 2, peak: 3 });
    const visible = timeline.lanes.flatMap((lane) => lane.bars);
    expect(visible.map((bar) => bar.loopId).sort()).toEqual(["clipped", "new", "old-running", "previous"]);
    expect(visible.find((bar) => bar.loopId === "clipped")).toMatchObject({ start: epoch + 10_000, end: epoch + 15_000 });
    expect(visible.find((bar) => bar.loopId === "old-running")).toMatchObject({ start: epoch + 10_000, end: epoch + 30_000, latest: false });
    expect(visible.filter((bar) => bar.latest).map((bar) => bar.loopId)).toEqual(["new"]);
    expect(model.timelineHistory.find((loop) => loop.loopId === "clipped")!.receivedAt).toBe(epoch + 5_000);
    const later = deriveTimeline(model, "latest", epoch + 40_000, true);
    expect(later.lanes.flatMap((lane) => lane.bars).map((bar) => bar.loopId).sort()).toEqual(["future", "new", "old-running"]);
  });

  it("stacks matching agent and loop IDs from different requests without mixing single requests", () => {
    const model = apply(...completed(0, 20, "same"), ...completed(5, 30, "same", "Pace", "other"));
    expect(bars(model)).toMatchObject([{ requestId: "req", start: epoch, end: epoch + 20, row: 0 }]);
    const lane = deriveTimeline(model, "other", epoch + 100, true).lanes.find((item) => item.agent === "Pace")!;
    expect(lane.bars).toMatchObject([{ requestId: "req", row: 0, latest: false }, { requestId: "other", row: 1, latest: true }]);
    expect(bars(model, 100, "absent")).toEqual([]);
  });

  it("extends unfinished loops from the earliest observed timestamp without inventing received events", () => {
    const model = apply(event(10, "received"), event(20, "thinking"), event(30, "tool", "missing"), event(25, "thinking", "missing"));
    expect(bars(model, 70)).toMatchObject([
      { start: epoch + 10, end: epoch + 70, incomplete: false },
      { start: epoch + 25, end: epoch + 70, phase: "tool", incomplete: true },
    ]);
    expect(deriveTimeline(model, "req", epoch + 90).running).toBe(2);
    expect(bars(model, 90).map((bar) => bar.end)).toEqual([epoch + 90, epoch + 90]);
  });

  it("keeps the earliest received and terminal timestamps through duplicate and out-of-order phases", () => {
    const model = apply(event(50, "answered"), event(30, "tool"), event(10, "received"), event(5, "received"),
      event(20, "thinking"), event(70, "thinking"), event(90, "answered"));
    expect(bars(model)).toMatchObject([{ start: epoch + 5, end: epoch + 50, phase: "answered" }]);
    const duplicate = applyEnvelope(model, event(50, "answered"));
    expect(duplicate.timelineHistory).toBe(model.timelineHistory);
    expect(bars(applyEnvelope(model, event(40, "answered")))[0]!.end).toBe(epoch + 40);
    expect(bars(model)[0]!.end).toBe(epoch + 50);
  });

  it("preserves failed endings and zero-length terminal-only recovery", () => {
    const model = apply(event(10, "received"), event(35, "failed"), event(60, "thinking"), event(20, "failed", "missing"));
    expect(bars(model)).toMatchObject([
      { start: epoch + 10, end: epoch + 35, phase: "failed", incomplete: false },
      { start: epoch + 20, end: epoch + 20, phase: "failed", incomplete: true },
    ]);
    expect(deriveTimeline(model, "req", epoch + 100).running).toBe(0);
  });

  it("does not regress phases when timestamps are equal", () => {
    const model = apply(event(10, "received"), event(10, "tool"), event(10, "thinking"));
    expect(bars(model)[0]!.phase).toBe("tool");
    expect(bars(applyEnvelope(applyEnvelope(model, event(10, "answered")), event(10, "tool")))[0]!.phase).toBe("answered");
  });

  it("clears history on reset without changing the previous model", () => {
    const before = apply(...completed(0, 20, "one"));
    const after = applyEnvelope(before, { v: 1, at: new Date(epoch + 30).toISOString(), type: "state.reset", data: {} });
    expect(bars(after)).toEqual([]);
    expect(after.activity).toEqual({});
    expect(after.reload).toBe(true);
    expect(before.timelineHistory).toHaveLength(1);
    expect(initialModel.timelineHistory).toEqual([]);
  });

  it("stops cancelled loops without hiding completed answers or counting them as running", () => {
    const before = { ...apply(...completed(0, 20, "done"), event(10, "received", "pending", "Coach")), snapshot };
    const after = applyEnvelope(before, { v: 1, type: "request.cancelled", at: new Date(epoch + 30).toISOString(),
      data: { requestId: "req", request: { kind: "expense", input: "coffee", createdAt: new Date(epoch).toISOString(),
        verdicts: {}, status: "cancelled", reason: "simulation_stopped" } } });
    expect(bars(after)).toEqual(expect.arrayContaining([
      expect.objectContaining({ loopId: "done", end: epoch + 20, phase: "answered" }),
      expect.objectContaining({ loopId: "pending", end: epoch + 30, phase: "cancelled" }),
    ]));
    expect(deriveTimeline(after, "req", epoch + 100, true).running).toBe(0);
  });

  it("retains only the newest 200 loops and rejects older recovery", () => {
    let model = { ...initialModel };
    for (let index = 0; index < 205; index++) model = applyEnvelope(model, event(index * 10, "received", `loop-${index}`));
    expect(bars(model, 3000)).toHaveLength(200);
    expect(bars(model, 3000)[0]!.loopId).toBe("loop-5");
    expect(deriveTimeline(model, "req", epoch + 3000, true)).toMatchObject({ peak: 200, running: 200 });
    expect(applyEnvelope(model, event(0, "received", "loop-0")).timelineHistory).toEqual(model.timelineHistory);
  });

  it("preserves history when snapshot recovery replays earlier and repeated events", async () => {
    let current = apply(...completed(10, 50, "one"));
    const { promise, resolve } = Promise.withResolvers<StateResponse>();
    const sync = new SnapshotSync(() => promise, () => current, (next) => { current = next; });
    const loading = sync.reload();
    sync.receive(event(50, "answered"));
    sync.receive(event(5, "received"));
    resolve(snapshot);
    await loading;
    expect(bars(current)).toMatchObject([{ start: epoch + 5, end: epoch + 50, phase: "answered" }]);
    sync.dispose();
  });
});
