import { AgentName } from "@budget-crew/shared";
import type { TimelineLoop, ViewModel } from "./model.js";

export interface TimelineBar {
  loopId: string;
  requestId?: string;
  start: number;
  end: number;
  phase: TimelineLoop["phase"];
  incomplete: boolean;
  latest: boolean;
  row: number;
}

export interface TimelineLane {
  agent: string;
  bars: TimelineBar[];
  rows: number;
}

export interface Timeline {
  start: number;
  end: number;
  lanes: TimelineLane[];
  peak: number;
  running: number;
}

/** Timelapse uses a rolling 20-second window; a single request keeps its own scale.
 * Intervals are half-open: touching endpoints share a stack row, not concurrency.
 * All data comes from the existing bounded activity history.
 */
export function deriveTimeline(model: ViewModel, requestId: string | undefined, nowMs: number, rolling = false): Timeline {
  const windowStart = nowMs - 20_000;
  const lanes: TimelineLane[] = AgentName.options.map((agent) => ({ agent, bars: [], rows: 1 }));
  const endpoints: { at: number; delta: number }[] = [];
  let start = rolling ? windowStart : nowMs;
  let end = nowMs;
  let running = 0;
  let hasBars = false;

  for (const loop of model.timelineHistory) {
    if (!rolling && loop.requestId !== requestId) continue;
    const lane = lanes.find((candidate) => candidate.agent === loop.agent);
    if (!lane) continue;
    const observedStart = loop.receivedAt ?? loop.firstAt;
    const observedEnd = Math.max(observedStart, loop.terminalAt ?? nowMs);
    if (rolling && (observedStart > nowMs || observedEnd < windowStart
      || (observedEnd === windowStart && observedStart < windowStart))) continue;
    const bar: TimelineBar = {
      loopId: loop.loopId, requestId: loop.requestId,
      start: rolling ? Math.max(windowStart, observedStart) : observedStart,
      end: rolling ? Math.min(nowMs, observedEnd) : observedEnd,
      phase: loop.phase, incomplete: loop.receivedAt === undefined,
      latest: requestId !== undefined && loop.requestId === requestId, row: 0,
    };
    lane.bars.push(bar);
    if (!rolling) {
      start = hasBars ? Math.min(start, bar.start) : bar.start;
      end = hasBars ? Math.max(end, bar.end) : bar.end;
    }
    hasBars = true;
    if (loop.terminalAt === undefined && observedStart <= nowMs) running++;
    if (bar.end > bar.start) endpoints.push({ at: bar.start, delta: 1 }, { at: bar.end, delta: -1 });
  }

  for (const lane of lanes) {
    lane.bars.sort((a, b) => a.start - b.start || a.end - b.end
      || a.loopId.localeCompare(b.loopId) || (a.requestId ?? "").localeCompare(b.requestId ?? ""));
    const rowEnds: number[] = [];
    for (const bar of lane.bars) {
      let row = rowEnds.findIndex((rowEnd) => rowEnd <= bar.start);
      if (row < 0) row = rowEnds.length;
      bar.row = row;
      rowEnds[row] = bar.end;
    }
    lane.rows = Math.max(1, rowEnds.length);
  }

  endpoints.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0;
  let peak = 0;
  for (const endpoint of endpoints) {
    active += endpoint.delta;
    peak = Math.max(peak, active);
  }
  return { start, end, lanes, peak, running };
}
