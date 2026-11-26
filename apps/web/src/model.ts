import type { ActivityEnvelope, RequestState, StateEnvelope, StateResponse } from "@budget-crew/shared";

export interface TimelineLoop {
  agent: string;
  loopId: string;
  requestId?: string;
  firstAt: number;
  receivedAt?: number;
  terminalAt?: number;
  phase: ActivityEnvelope["data"]["phase"] | "cancelled";
  phaseAt: number;
}

export interface ViewModel {
  snapshot: StateResponse | null;
  activity: Record<string, ActivityEnvelope>;
  timelineHistory: TimelineLoop[];
  reload: boolean;
  status: string;
  error?: string;
}
export type Envelope = StateEnvelope | ActivityEnvelope;
export const initialModel: ViewModel = { snapshot: null, activity: {}, timelineHistory: [], reload: false, status: "Connecting" };

// Keep only the newest 200 loops, not a growing log of every phase publication.
function recordTimeline(history: TimelineLoop[], event: ActivityEnvelope): TimelineLoop[] {
  const at = Date.parse(event.at);
  const { agent, loopId, requestId, phase } = event.data;
  const index = history.findIndex((loop) => loop.agent === agent && loop.loopId === loopId && loop.requestId === requestId);
  const previous = history[index];
  const terminal = phase === "answered" || phase === "failed";
  const next: TimelineLoop = previous ? { ...previous } : { agent, loopId, requestId, firstAt: at, phase, phaseAt: at };
  next.firstAt = Math.min(next.firstAt, at);
  if (phase === "received") next.receivedAt = Math.min(next.receivedAt ?? at, at);
  if (terminal && (next.terminalAt === undefined || at < next.terminalAt)) {
    next.terminalAt = at;
    next.phase = phase;
    next.phaseAt = at;
  } else if (!terminal && phase !== "received" && next.terminalAt === undefined
    && (at > next.phaseAt || (at === next.phaseAt && (next.phase === "received" || phase === "tool")))) {
    next.phase = phase;
    next.phaseAt = at;
  }
  if (previous && next.firstAt === previous.firstAt && next.receivedAt === previous.receivedAt
    && next.terminalAt === previous.terminalAt && next.phase === previous.phase && next.phaseAt === previous.phaseAt) return history;
  const updated = history.slice();
  if (index < 0) updated.push(next);
  else updated[index] = next;
  updated.sort((a, b) => a.firstAt - b.firstAt);
  return updated.length > 200 ? updated.slice(-200) : updated;
}

export function acceptRequest(model: ViewModel, id: string, request: RequestState): ViewModel {
  if (!model.snapshot) return model;
  const existing = model.snapshot.requests[id];
  return { ...model, snapshot: { ...model.snapshot, requests: { ...model.snapshot.requests,
    [id]: { ...request, ...existing, input: request.input, createdAt: request.createdAt },
  } } };
}

export function applyEnvelope(model: ViewModel, event: Envelope): ViewModel {
  if (event.type === "state.reset") return { ...model, activity: {}, timelineHistory: [], reload: true };
  if (event.type === "agent.activity") {
    const key = `${event.data.agent}:${event.data.loopId}`;
    const timelineHistory = recordTimeline(model.timelineHistory, event);
    const previous = model.activity[key];
    if (previous && previous.at > event.at) return timelineHistory === model.timelineHistory ? model : { ...model, timelineHistory };
    return { ...model, timelineHistory, activity: { ...model.activity, [key]: event } };
  }
  if (!model.snapshot) return model;
  const snapshot = { ...model.snapshot, requests: { ...model.snapshot.requests }, periods: [...model.snapshot.periods] };
  const data = event.data;
  const requestId = "requestId" in data ? data.requestId : undefined;
  if (requestId) {
    const previous = snapshot.requests[requestId];
    const kind = event.type === "purchase.parsed" || event.type === "purchase.judged" ? "purchase"
      : event.type === "income.recorded" || event.type === "period.started" ? "income" : "expense";
    snapshot.requests[requestId] = { ...(previous ?? { kind, input: "", verdicts: {}, createdAt: event.at }) };
  }
  const request = requestId ? snapshot.requests[requestId]! : undefined;
  switch (event.type) {
    case "request.cancelled": {
      snapshot.requests[event.data.requestId] = event.data.request;
      const at = Date.parse(event.at);
      const timelineHistory = model.timelineHistory.map((loop) => loop.requestId === event.data.requestId && loop.terminalAt === undefined
        ? { ...loop, terminalAt: Math.max(loop.firstAt, at), phaseAt: at, phase: "cancelled" as const } : loop);
      return { ...model, snapshot, timelineHistory };
    }
    case "expense.recorded":
    case "income.recorded": {
      const recorded = event.type === "expense.recorded"
        ? snapshot.periods.some((p) => p.expenses.some((e) => e.id === event.data.expense.id))
        : snapshot.periods.some((p) => p.extraIncomes.some((i) => i.id === event.data.income.id));
      if (recorded) return model;
      const period = snapshot.periods.find((p) => p.id === snapshot.currentPeriodId);
      if (period) {
        const projection = period.projection.map((day) => day.date === event.data.projectionToday.date ? { ...event.data.projectionToday, remaining: event.data.remaining } : day);
        if (event.type === "expense.recorded") {
          const expense = event.data.expense;
          snapshot.periods = snapshot.periods.map((p) => p.id !== period.id ? p : { ...p, projection,
            expenses: [...p.expenses.filter((e) => e.id !== expense.id), expense] });
        } else {
          const income = event.data.income;
          snapshot.periods = snapshot.periods.map((p) => p.id !== period.id ? p : { ...p, projection,
            extraIncomes: [...p.extraIncomes.filter((i) => i.id !== income.id), income] });
        }
      }
      request!.parsed = event.type === "expense.recorded"
        ? { amount: event.data.expense.amount, category: event.data.expense.category, note: event.data.expense.note }
        : { amount: event.data.income.amount, kind: event.data.income.kind, source: event.data.income.source };
      break;
    }
    case "period.started":
      if (snapshot.periods.some((p) => p.id === event.data.period.id)) return model;
      snapshot.periods.push(event.data.period);
      snapshot.currentPeriodId = event.data.period.id;
      request!.parsed = { amount: event.data.period.salary.amount, kind: "salary", source: event.data.period.salary.source };
      break;
    case "period.closed":
      snapshot.periods = snapshot.periods.map((p) => p.id === event.data.periodId ? { ...p, status: "closed", finalBalance: event.data.finalBalance } : p);
      if (snapshot.currentPeriodId === event.data.periodId) delete snapshot.currentPeriodId;
      break;
    case "purchase.parsed": request!.parsed = event.data.purchase; break;
    case "verdict.recorded": request!.verdicts = { ...request!.verdicts, [event.data.agent]: event.data.verdict }; break;
    case "purchase.judged": request!.judgement = event.data.judgement; break;
    case "request.failed": request!.error = event.data.error; break;
    case "simulation.tick":
    case "simulation.finished":
      snapshot.today = event.data.day;
      snapshot.simulation = { ...event.data };
      break;
  }
  return { ...model, snapshot };
}

function changesProjection(event: Envelope): boolean {
  return event.type === "expense.recorded" || event.type === "income.recorded"
    || event.type === "simulation.tick" || event.type === "simulation.finished"
    || event.type === "period.started" || event.type === "period.closed";
}

// A reset invalidates any in-flight HTTP response. Events received during a fetch
// are replayed in channel order after its snapshot, including recovered events.
export class SnapshotSync {
  private generation = 0;
  private pending: Envelope[] | null = null;
  private refreshPending = false;
  constructor(private load: () => Promise<StateResponse>, private get: () => ViewModel, private set: (model: ViewModel) => void) {}
  async reload(): Promise<void> {
    const generation = ++this.generation;
    this.pending ??= [];
    this.refreshPending = false;
    this.set({ ...this.get(), reload: false, error: undefined });
    try {
      const snapshot = await this.load();
      if (generation !== this.generation) return;
      let model: ViewModel = { ...this.get(), snapshot, reload: false, error: undefined };
      for (const event of this.pending ?? []) model = applyEnvelope(model, event);
      this.pending = null;
      this.set(model);
      // A publication can land after this request's snapshot was captured.
      // Its point payload cannot reconstruct redistribution across future days.
      if (this.refreshPending) void this.reload();
    } catch (error) {
      if (generation !== this.generation) return;
      for (const event of this.pending ?? []) this.set(applyEnvelope(this.get(), event));
      this.pending = null;
      this.set({ ...this.get(), error: error instanceof Error ? error.message : "Snapshot unavailable" });
    }
  }
  receive(event: Envelope): void {
    if (event.type === "state.reset") {
      this.set(applyEnvelope(this.get(), event));
      this.pending = null;
      void this.reload();
    } else if (this.pending) {
      this.pending.push(event);
      this.refreshPending ||= changesProjection(event);
    }
    else {
      const unknown = event.type !== "agent.activity" && "requestId" in event.data && !this.get().snapshot?.requests[event.data.requestId]?.input;
      this.set(applyEnvelope(this.get(), event));
      if (unknown || changesProjection(event)) void this.reload();
    }
  }
  dispose(): void { ++this.generation; this.pending = null; this.refreshPending = false; }
}
