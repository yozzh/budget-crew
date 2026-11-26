import type { ActivityEnvelope, RequestState, StateEnvelope, StateResponse } from "@budget-crew/shared";

export interface ViewModel {
  snapshot: StateResponse | null;
  activity: Record<string, ActivityEnvelope>;
  reload: boolean;
  status: string;
  error?: string;
}
export type Envelope = StateEnvelope | ActivityEnvelope;
export const initialModel: ViewModel = { snapshot: null, activity: {}, reload: false, status: "Connecting" };

export function acceptRequest(model: ViewModel, id: string, request: RequestState): ViewModel {
  if (!model.snapshot) return model;
  const existing = model.snapshot.requests[id];
  return { ...model, snapshot: { ...model.snapshot, requests: { ...model.snapshot.requests,
    [id]: { ...request, ...existing, input: request.input, createdAt: request.createdAt },
  } } };
}

export function applyEnvelope(model: ViewModel, event: Envelope): ViewModel {
  if (event.type === "state.reset") return { ...model, activity: {}, reload: true };
  if (event.type === "agent.activity") {
    const key = `${event.data.agent}:${event.data.loopId}`;
    const previous = model.activity[key];
    if (previous && previous.at > event.at) return model;
    return { ...model, activity: { ...model.activity, [key]: event } };
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
    case "simulation.tick": snapshot.today = event.data.day; snapshot.simulation = { ...snapshot.simulation, ...event.data }; break;
  }
  return { ...model, snapshot };
}

// A reset invalidates any in-flight HTTP response. Events received during a fetch
// are replayed in channel order after its snapshot, including recovered events.
export class SnapshotSync {
  private generation = 0;
  private pending: Envelope[] | null = null;
  constructor(private load: () => Promise<StateResponse>, private get: () => ViewModel, private set: (model: ViewModel) => void) {}
  async reload(): Promise<void> {
    const generation = ++this.generation;
    this.pending ??= [];
    this.set({ ...this.get(), reload: false, error: undefined });
    try {
      const snapshot = await this.load();
      if (generation !== this.generation) return;
      let model: ViewModel = { ...this.get(), snapshot, reload: false, error: undefined };
      for (const event of this.pending ?? []) model = applyEnvelope(model, event);
      this.pending = null;
      this.set(model);
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
    } else if (this.pending) this.pending.push(event);
    else {
      const unknown = event.type !== "agent.activity" && "requestId" in event.data && !this.get().snapshot?.requests[event.data.requestId]?.input;
      this.set(applyEnvelope(this.get(), event));
      if (unknown || event.type === "simulation.tick" || event.type === "period.closed") void this.reload();
    }
  }
  dispose(): void { ++this.generation; this.pending = null; }
}
