import type { TimelineLoop, ViewModel } from "./model.js";

export interface TimelineLane {
  agent: string;
  loopId: string;
  start: number;
  end: number;
  phase: TimelineLoop["phase"];
  incomplete: boolean;
}

export interface Timeline {
  start: number;
  end: number;
  lanes: TimelineLane[];
  peak: number;
}

/** Absolute epoch milliseconds; missing received events use the earliest observed phase.
 * Empty requests have a zero-width range at nowMs. Touching endpoints do not overlap.
 */
export function deriveTimeline(model: ViewModel, requestId: string, nowMs: number): Timeline {
  const lanes = model.timelineHistory.filter((loop) => loop.requestId === requestId).map((loop): TimelineLane => {
    const start = loop.receivedAt ?? loop.firstAt;
    return {
      agent: loop.agent,
      loopId: loop.loopId,
      start,
      end: Math.max(start, loop.terminalAt ?? nowMs),
      phase: loop.phase,
      incomplete: loop.receivedAt === undefined,
    };
  }).sort((a, b) => a.start - b.start || a.agent.localeCompare(b.agent) || a.loopId.localeCompare(b.loopId));
  if (!lanes.length) return { start: nowMs, end: nowMs, lanes, peak: 0 };

  const endpoints: { at: number; delta: number }[] = [];
  let start = lanes[0]!.start;
  let end = lanes[0]!.end;
  for (const lane of lanes) {
    start = Math.min(start, lane.start);
    end = Math.max(end, lane.end);
    if (lane.end > lane.start) endpoints.push({ at: lane.start, delta: 1 }, { at: lane.end, delta: -1 });
  }
  endpoints.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0;
  let peak = 0;
  for (const endpoint of endpoints) {
    active += endpoint.delta;
    peak = Math.max(peak, active);
  }
  return { start, end, lanes, peak };
}
