import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Injectable, ConflictException } from "@nestjs/common";
import { RuntimeState } from "@mozaik-ai/core";
import { closePeriod, openPeriod, projectDaily, type ISODate, type Income, type Expense, type Period } from "@budget-crew/budget";
import { BudgetStateSnapshot, type RequestState, type AgentName, type VerdictSlot, type Judgement } from "@budget-crew/shared";

const shift = (date: ISODate, days: number): ISODate => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10) as ISODate;
const utcToday = (): ISODate => new Date().toISOString().slice(0, 10) as ISODate;

/** The runtime keeps this object for its lifetime, including across resets. */
export class BudgetState extends RuntimeState implements BudgetStateSnapshot {
  profile!: BudgetStateSnapshot["profile"];
  periods!: Period[];
  currentPeriodId?: string;
  today!: ISODate;
  requests!: Record<string, RequestState>;
  simulation!: BudgetStateSnapshot["simulation"];
}

@Injectable()
export class BudgetStore {
  readonly state = new BudgetState();
  private readonly resetListeners = new Set<() => void>();

  onReset(listener: () => void): () => void {
    this.resetListeners.add(listener);
    return () => { this.resetListeners.delete(listener); };
  }

  failRequest(requestId: string, error: string): void {
    this.request(requestId).error = error;
  }

  cancelSimulationRequest(requestId: string): RequestState | undefined {
    const request = this.state.requests[requestId];
    if (!request || request.source !== "sim" || request.status === "cancelled" || request.error) return;
    const expected: AgentName[] = request.kind === "expense" ? ["Pace", "Anomaly", "Coach"]
      : request.kind === "purchase" ? ["Impact", "Obligations", "Deal Check", "Alternatives"]
        : request.parsed && "kind" in request.parsed && request.parsed.kind === "salary"
          ? ["Planner", "Obligations"] : ["Pace", "Coach"];
    if (request.kind === "purchase" ? request.judgement !== undefined
      : request.parsed !== undefined && expected.every(agent => request.verdicts[agent])) return;
    request.status = "cancelled";
    request.reason = "simulation_stopped";
    for (const agent of expected) {
      request.verdicts[agent] ??= { status: "cancelled", reason: "simulation_stopped" };
    }
    return request;
  }

  constructor() { this.reset(); }

  snapshot(requestLimit = 200): BudgetStateSnapshot {
    const { profile, periods, currentPeriodId, today, requests, simulation } = this.state;
    return structuredClone({ profile, periods, currentPeriodId, today,
      requests: Object.fromEntries(Object.entries(requests).slice(-requestLimit)), simulation });
  }

  reset(today: ISODate = utcToday(), options: { openPeriod?: boolean } = {}): void {
    for (const listener of this.resetListeners) listener();
    const paths = [new URL("../../../../seed/synthetic-user.json", import.meta.url), new URL("../../seed/synthetic-user.json", import.meta.url)];
    const path = paths.find(url => existsSync(fileURLToPath(url)));
    if (!path) throw new Error("Synthetic seed not found");
    const seed = JSON.parse(readFileSync(path, "utf8")) as {
      profile: BudgetStateSnapshot["profile"];
      salary: { amount: number; source: string };
      expenses: { day: number; amount: number; category: string; note: string }[];
    };
    const start = `${today.slice(0, 7)}-01` as ISODate;
    const period = options.openPeriod === false ? undefined
      : openPeriod(seed.profile, { id: "seed-salary", date: start, ...seed.salary, kind: "salary" }, 0);
    if (period) {
      period.expenses = seed.expenses.filter(expense => expense.day <= Number(today.slice(8))).map((expense, index) => ({
        id: `seed-expense-${index}`, date: `${today.slice(0, 7)}-${String(expense.day).padStart(2, "0")}` as ISODate,
        amount: expense.amount, category: expense.category, note: expense.note, source: "user",
      }));
    }
    const snapshot = BudgetStateSnapshot.parse({ profile: seed.profile, periods: period ? [period] : [], currentPeriodId: period?.id,
      today, requests: {}, simulation: { running: false, speed: 4 } });
    Object.assign(this.state, snapshot);
    this.recompute();
  }

  beginRequest(requestId: string, kind: RequestState["kind"], input: string, createdAt = new Date().toISOString()): void {
    if (!Object.hasOwn(this.state.requests, requestId)) {
      Object.defineProperty(this.state.requests, requestId, { value: { kind, input, verdicts: {}, createdAt }, enumerable: true, configurable: true, writable: true });
      const ids = Object.keys(this.state.requests);
      for (const id of ids.slice(0, Math.max(0, ids.length - 200))) delete this.state.requests[id];
    }
    this.recompute();
  }

  recordExpense(expense: Expense): void {
    const period = this.open();
    this.assertDate(period, expense.date);
    if (expense.requestId) this.beginRequest(expense.requestId, "expense", expense.note);
    period.expenses.push(structuredClone(expense));
    if (expense.requestId) this.request(expense.requestId).parsed = { amount: expense.amount, category: expense.category, note: expense.note };
    this.recompute();
  }

  recordIncome(income: Income): void {
    const current = this.current();
    let closed: { period: Period; finalBalance: number } | undefined;
    let next: Period | undefined;
    if (income.kind === "salary") {
      if (current) {
        // Late salaries close at the planned end; early salaries preserve the original plan.
        const previousDay = shift(income.date, -1);
        closed = closePeriod(current, previousDay < current.end ? previousDay : current.end);
      }
      next = openPeriod(this.state.profile, income, closed?.finalBalance ?? 0);
    } else {
      this.assertDate(this.open(), income.date);
    }
    if (income.requestId) this.beginRequest(income.requestId, "income", income.source);
    if (next) {
      if (closed && current) this.state.periods[this.state.periods.indexOf(current)] = closed.period;
      this.state.periods.push(next);
      this.state.currentPeriodId = next.id;
    } else {
      this.open().extraIncomes.push(structuredClone(income));
    }
    if (income.requestId) this.request(income.requestId).parsed = { amount: income.amount, kind: income.kind, source: income.source };
    this.recompute();
  }

  putVerdict(requestId: string, agent: AgentName, verdict: VerdictSlot): void {
    this.request(requestId).verdicts[agent] = structuredClone(verdict);
    this.recompute();
  }

  putJudgement(requestId: string, judgement: Judgement): void {
    this.request(requestId).judgement = structuredClone(judgement);
    this.recompute();
  }

  setToday(today: ISODate): void {
    this.state.today = today;
    this.recompute();
  }

  private request(id: string): RequestState {
    if (!Object.hasOwn(this.state.requests, id)) throw new Error(`Unknown request: ${id}`);
    return this.state.requests[id]!;
  }

  private current(): Period | undefined {
    return this.state.periods.find(period => period.id === this.state.currentPeriodId && period.status === "open");
  }

  private open(): Period {
    const period = this.current();
    if (!period) throw new ConflictException({ error: "no_open_period" });
    return period;
  }

  private assertDate(period: Period, date: ISODate): void {
    if (date < period.start || date > period.end) throw new RangeError("Date must be inside the open period");
  }

  private recompute(): void {
    const period = this.current();
    if (!period) return;
    const dates: ISODate[] = [];
    for (let day = period.start; day <= period.end; day = shift(day, 1)) dates.push(day);
    const totals = (entries: { date: ISODate; amount: number }[]): Partial<Record<ISODate, number>> => {
      const result: Partial<Record<ISODate, number>> = {};
      for (const entry of entries) result[entry.date] = (result[entry.date] ?? 0) + entry.amount;
      return result;
    };
    period.projection = projectDaily({ dates,
      residual: period.salary.amount + period.carryover - period.articles.reduce((sum, article) => sum + article.amount, 0),
      expensesByDate: totals(period.expenses), incomesByDate: totals(period.extraIncomes), today: this.state.today });
  }
}
