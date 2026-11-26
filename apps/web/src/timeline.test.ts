import { describe, expect, it } from "vitest";
import type { ActivityEnvelope, StateResponse } from "@budget-crew/shared";
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

const snapshot: StateResponse = {
  profile: { name: "Demo", currency: "EUR", payday: 1, recurringArticles: [] },
  today: "2026-11-26", periods: [], requests: {}, simulation: { running: false, speed: 1 },
};

describe("request timelines", () => {
  it("measures actual overlap, including multiple loops for one agent", () => {
    const model = apply(...completed(0, 100, "one"), ...completed(20, 60, "two"), ...completed(40, 80, "three", "Buffer"));
    const timeline = deriveTimeline(model, "req", epoch + 200);
    expect(timeline).toEqual({
      start: epoch, end: epoch + 100, peak: 3,
      lanes: [
        { agent: "Pace", loopId: "one", start: epoch, end: epoch + 100, phase: "answered", incomplete: false },
        { agent: "Pace", loopId: "two", start: epoch + 20, end: epoch + 60, phase: "answered", incomplete: false },
        { agent: "Buffer", loopId: "three", start: epoch + 40, end: epoch + 80, phase: "answered", incomplete: false },
      ],
    });
    expect(model.activity["Pace:one"]!.data.phase).toBe("answered");
    expect(model.activity["Pace:two"]!.data.phase).toBe("answered");
  });

  it("does not count serial intervals, touching endpoints, or zero durations as overlapping", () => {
    const model = apply(...completed(0, 20, "one"), ...completed(20, 40, "two"), ...completed(70, 90, "three"), ...completed(20, 20, "instant"));
    expect(deriveTimeline(model, "req", epoch + 100).peak).toBe(1);
    const instant = deriveTimeline(apply(...completed(10, 10, "instant")), "req", epoch + 100);
    expect(instant).toMatchObject({ start: epoch + 10, end: epoch + 10, peak: 0 });
    expect(instant.lanes[0]).toMatchObject({ start: epoch + 10, end: epoch + 10, incomplete: false });
  });

  it("extends unfinished lanes to now without inventing a received event", () => {
    const model = apply(event(10, "received"), event(20, "thinking"), event(30, "tool", "missing"), event(25, "thinking", "missing"));
    expect(deriveTimeline(model, "req", epoch + 70)).toEqual({
      start: epoch + 10, end: epoch + 70, peak: 2,
      lanes: [
        { agent: "Pace", loopId: "one", start: epoch + 10, end: epoch + 70, phase: "thinking", incomplete: false },
        { agent: "Pace", loopId: "missing", start: epoch + 25, end: epoch + 70, phase: "tool", incomplete: true },
      ],
    });
    expect(deriveTimeline(model, "req", epoch + 90).lanes.map((lane) => lane.end)).toEqual([epoch + 90, epoch + 90]);
    expect(deriveTimeline(apply(event(50, "received")), "req", epoch + 40)).toMatchObject({ start: epoch + 50, end: epoch + 50, peak: 0 });
  });

  it("keeps the earliest received and terminal timestamps through repeated and out-of-order phases", () => {
    const model = apply(
      event(50, "answered"), event(30, "tool"), event(10, "received"), event(5, "received"),
      event(20, "thinking"), event(15, "received"), event(70, "thinking"), event(90, "answered"), event(50, "answered"),
    );
    expect(deriveTimeline(model, "req", epoch + 100).lanes).toEqual([
      { agent: "Pace", loopId: "one", start: epoch + 5, end: epoch + 50, phase: "answered", incomplete: false },
    ]);
    const duplicate = applyEnvelope(model, event(50, "answered"));
    expect(duplicate.timelineHistory).toBe(model.timelineHistory);
    expect(duplicate.activity).toBe(model.activity);
    const recovered = applyEnvelope(model, event(40, "answered"));
    expect(deriveTimeline(recovered, "req", epoch + 100).lanes[0]!.end).toBe(epoch + 40);
    expect(deriveTimeline(model, "req", epoch + 100).lanes[0]!.end).toBe(epoch + 50);
  });

  it("preserves failed endings and zero-length terminal-only recovery", () => {
    const model = apply(event(10, "received"), event(35, "failed"), event(60, "thinking"), event(90, "failed"), event(20, "failed", "missing"));
    expect(deriveTimeline(model, "req", epoch + 100)).toEqual({
      start: epoch + 10, end: epoch + 35, peak: 1,
      lanes: [
        { agent: "Pace", loopId: "one", start: epoch + 10, end: epoch + 35, phase: "failed", incomplete: false },
        { agent: "Pace", loopId: "missing", start: epoch + 20, end: epoch + 20, phase: "failed", incomplete: true },
      ],
    });
  });

  it("does not regress phases when timestamps are equal", () => {
    const model = apply(event(10, "received"), event(10, "tool"), event(10, "thinking"), event(10, "received"));
    expect(deriveTimeline(model, "req", epoch + 30).lanes[0]!.phase).toBe("tool");
    const ended = applyEnvelope(model, event(10, "answered"));
    expect(deriveTimeline(applyEnvelope(ended, event(10, "tool")), "req", epoch + 30).lanes[0]!.phase).toBe("answered");
  });

  it("isolates requests even when their agent and loop IDs match", () => {
    const background = event(10, "received", "background");
    delete background.data.requestId;
    const model = apply(...completed(0, 20, "same"), ...completed(5, 30, "same", "Pace", "other"), background);
    expect(deriveTimeline(model, "req", epoch + 100)).toMatchObject({ start: epoch, end: epoch + 20, peak: 1 });
    expect(deriveTimeline(model, "req", epoch + 100).lanes).toHaveLength(1);
    expect(deriveTimeline(model, "other", epoch + 100)).toMatchObject({ start: epoch + 5, end: epoch + 30, peak: 1 });
    expect(deriveTimeline(model, "absent", epoch + 100)).toEqual({ start: epoch + 100, end: epoch + 100, lanes: [], peak: 0 });
  });

  it("clears all history on reset without changing the previous model", () => {
    const before = apply(...completed(0, 20, "one"));
    const after = applyEnvelope(before, { v: 1, at: new Date(epoch + 30).toISOString(), type: "state.reset", data: {} });
    expect(after.timelineHistory).toEqual([]);
    expect(after.activity).toEqual({});
    expect(after.reload).toBe(true);
    expect(deriveTimeline(after, "req", epoch + 40).lanes).toEqual([]);
    expect(before.timelineHistory).toHaveLength(1);
    expect(initialModel.timelineHistory).toEqual([]);
  });

  it("ends cancelled simulation lanes at stop time without hiding completed answers", () => {
    const before = { ...apply(...completed(0, 20, "done"), event(10, "received", "pending", "Coach")), snapshot };
    const after = applyEnvelope(before, { v: 1, type: "request.cancelled", at: new Date(epoch + 30).toISOString(),
      data: { requestId: "req", request: { kind: "expense", input: "coffee", createdAt: new Date(epoch).toISOString(),
        verdicts: {}, status: "cancelled", reason: "simulation_stopped" } } });
    expect(deriveTimeline(after, "req", epoch + 100).lanes).toMatchObject([
      { loopId: "done", end: epoch + 20, phase: "answered" },
      { loopId: "pending", end: epoch + 30, phase: "cancelled" },
    ]);
  });

  it("retains only the newest 200 loops and does not displace them with old recovery", () => {
    let model = { ...initialModel };
    for (let index = 0; index < 205; index++) model = applyEnvelope(model, event(index * 10, "received", `loop-${index}`));
    const timeline = deriveTimeline(model, "req", epoch + 3000);
    expect(model.timelineHistory).toHaveLength(200);
    expect(timeline.lanes).toHaveLength(200);
    expect(timeline.lanes[0]!.loopId).toBe("loop-5");
    expect(timeline.lanes[199]!.loopId).toBe("loop-204");
    const recovered = applyEnvelope(model, event(0, "received", "loop-0"));
    expect(recovered.timelineHistory).toEqual(model.timelineHistory);
    expect(deriveTimeline(recovered, "req", epoch + 3000).peak).toBe(200);
  });

  it("preserves history when snapshot recovery replays repeated and earlier events", async () => {
    let current = apply(...completed(10, 50, "one"));
    const { promise, resolve } = Promise.withResolvers<StateResponse>();
    const sync = new SnapshotSync(() => promise, () => current, (next) => { current = next; });
    const loading = sync.reload();
    sync.receive(event(50, "answered"));
    sync.receive(event(20, "thinking"));
    sync.receive(event(5, "received"));
    resolve(snapshot);
    await loading;
    expect(current.snapshot).toBe(snapshot);
    expect(deriveTimeline(current, "req", epoch + 100).lanes).toEqual([
      { agent: "Pace", loopId: "one", start: epoch + 5, end: epoch + 50, phase: "answered", incomplete: false },
    ]);
    sync.dispose();
  });
});
