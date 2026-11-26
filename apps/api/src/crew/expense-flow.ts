import { randomUUID } from "node:crypto";
import { createAgent, createHuman, SituationSpecification, SemanticEvent, type SituationContext } from "@mozaik-ai/core";
import { ConflictException, Inject, Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from "@nestjs/common";
import { DayAdvancedPayload, ExpenseSubmittedPayload, ExpenseRecordedPayload, IncomeSubmittedPayload, IncomeRecordedPayload, PeriodStartedPayload, PurchaseSubmittedPayload, PurchaseParsedPayload, PurchaseReadyPayload, ParsedExpense, ParsedIncome, ParsedPurchase, Judgement, Verdict, type RequestState, type StateEnvelope } from "@budget-crew/shared";
import { z } from "zod";
import { BudgetStore } from "../budget/budget.store.js";
import { CentrifugoPublisher } from "../realtime/centrifugo.publisher.js";
import { CrewRuntime } from "./crew-runtime.js";
import { createExpenseTools } from "./expense-tools.js";
import { createPurchaseTools } from "./purchase-tools.js";
import { formatMoneyFields } from "./money.js";
import { simulateBudget } from "@budget-crew/budget";

class Events extends SituationSpecification {
  constructor(private readonly types: readonly string[]) { super(); }
  isSatisfiedBy({ event }: SituationContext): boolean { return this.types.includes(event.type); }
}
const expenseAgents = ["Pace", "Anomaly", "Coach"] as const;
const incomeAgents = ["Pace", "Coach"] as const;
const periodAgents = ["Planner", "Obligations"] as const;
const verdictAgents = [...expenseAgents, ...periodAgents] as const;
type VerdictAgent = typeof verdictAgents[number];
const purchaseAgents = ["Impact", "Obligations", "Deal Check", "Alternatives"] as const;
type Link = { requestId: string; request: RequestState; agent: "Parser" | VerdictAgent | typeof purchaseAgents[number] | "Judge"; timer?: NodeJS.Timeout };
const format = (name: string, schema: z.ZodType) => ({ name, schema: z.toJSONSchema(schema), strict: true });

@Injectable()
export class ExpenseFlow implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExpenseFlow.name);
  private readonly human = createHuman({ name: "Human", capabilities: [], handlers: [] });
  private readonly links = new Map<string, Map<string, Link>>();
  private readonly submissions = new Map<string, z.infer<typeof ExpenseSubmittedPayload>>();
  private unsubscribe?: () => void;
  private ledgerId = "";
  private ready = new WeakSet<RequestState>();
  private simulationId?: string;
  private readonly simulationRequests = new Map<string, string>();
  private readonly pending = new Map<string, { link: Link; answer: unknown }>();

  constructor(@Inject(CrewRuntime) private readonly crew: CrewRuntime,
    @Inject(BudgetStore) private readonly store: BudgetStore,
    @Inject(CentrifugoPublisher) private readonly publisher: CentrifugoPublisher) {}

  onModuleInit(): void {
    const tools = createExpenseTools(this.store);
    const names = new Map<string, Link["agent"]>();
    const ledger = createHuman({ name: "Ledger", capabilities: [], handlers: [{
      specification: new Events(["day.advanced", "expense.submitted", "income.submitted", "purchase.submitted", "message_received.started", "model.answer"]),
      processor: { apply: ({ event }) => {
        if (event.type === "day.advanced") {
          const data = DayAdvancedPayload.parse(event.payload);
          if (data.runId && data.runId === this.simulationId) this.store.setToday(data.day);
          return;
        }
        if (event.type === "expense.submitted" || event.type === "income.submitted" || event.type === "purchase.submitted") {
          const kind = event.type === "purchase.submitted" ? "purchase" : event.type === "income.submitted" ? "income" : "expense";
          const data = (kind === "purchase" ? PurchaseSubmittedPayload : kind === "income" ? IncomeSubmittedPayload : ExpenseSubmittedPayload).parse(event.payload);
          if (data.source === "sim" && (data.runId === undefined || data.runId !== this.simulationId)) return;
          if (this.store.state.requests[data.requestId]) return;
          this.store.beginRequest(data.requestId, kind, data.text);
          const request = this.store.state.requests[data.requestId]!;
          request.source = data.source ?? "user";
          request.date = data.date ?? this.store.state.today;
          if (data.source === "sim") this.simulationRequests.set(data.requestId, data.runId!);
          if (kind !== "purchase") this.submissions.set(data.requestId, ExpenseSubmittedPayload.parse(event.payload));
          return;
        }
        const agent = names.get(event.producerId);
        if (!agent) return;
        const payload = event.payload as { loopId?: string; content?: string; answer?: { content?: { text?: string } } };
        if (!payload.loopId) return;
        let loops = this.links.get(event.producerId);
        if (event.type === "message_received.started") {
          const requestId = /^\[req:([^\]\r\n]+)\]/.exec(payload.content ?? "")?.[1];
          const request = requestId ? this.store.state.requests[requestId] : undefined;
          if (!requestId || !request || !this.isActive(requestId, request) || (request.kind !== "purchase" && !this.submissions.has(requestId))) return;
          if (!loops) { loops = new Map(); this.links.set(event.producerId, loops); }
          const link: Link = { requestId, request, agent };
          loops.set(payload.loopId, link);
          if (agent !== "Parser" && agent !== "Judge") {
            const loopId = payload.loopId;
            link.timer = setTimeout(() => {
              loops!.delete(loopId);
              if (this.isActive(link.requestId, link.request)) this.recordVerdict(link, { status: "failed", error: "timeout" });
            }, 45_000);
          }
          return;
        }
        const link = loops?.get(payload.loopId);
        if (!link) return;
        loops!.delete(payload.loopId);
        clearTimeout(link.timer);
        if (!this.isActive(link.requestId, link.request)) return;
        try {
          const answer: unknown = JSON.parse(payload.answer?.content?.text ?? "");
          if (agent === "Parser") {
            if (link.request.parsed || this.pending.has(link.requestId)) return;
            this.recordParsed(link, answer);
          } else if (agent === "Judge") {
            if (link.request.judgement || link.request.error) return;
            const judgement = Judgement.parse(answer);
            this.store.putJudgement(link.requestId, judgement);
            this.publish({ v: 1, type: "purchase.judged", at: new Date().toISOString(), data: { requestId: link.requestId, judgement } });
          } else {
            this.recordVerdict(link, Verdict.parse(answer));
          }
        } catch {
          if (agent === "Judge") {
            this.store.failRequest(link.requestId, "invalid_judgement");
            this.publish({ v: 1, type: "request.failed", at: new Date().toISOString(), data: { requestId: link.requestId, error: "invalid_judgement" } });
            return;
          }
          if (agent === "Parser") {
            this.failRequest(link.requestId, "invalid_parser_answer");
          } else this.recordVerdict(link, { status: "failed", error: "invalid_verdict" });
        }
      } },
    }] });
    this.ledgerId = ledger.getId();
    this.crew.join(ledger);
    this.crew.join(this.human);
    const parser = createAgent({ name: "Parser", instruction: "Extract integer euro cents. For expenses return amount, category and note; for incomes return amount, kind salary or extra, and source; for purchases return item, price and category. Return only the requested JSON. Do not invent missing details.",
      capabilities: [], tools: [], handlers: [{ specification: new Events(["expense.submitted", "income.submitted", "purchase.submitted"]), processor: { apply: ({ event }) => {
        const purchase = event.type === "purchase.submitted";
        const income = event.type === "income.submitted";
        const data = (purchase ? PurchaseSubmittedPayload : income ? IncomeSubmittedPayload : ExpenseSubmittedPayload).parse(event.payload);
        if (data.source === "sim" && (data.runId === undefined || data.runId !== this.simulationId)) return;
        this.crew.startLoop(parser, data.requestId, `${purchase ? "Purchase" : income ? "Income" : "Expense"}: ${data.text}`,
          purchase ? format("ParsedPurchase", ParsedPurchase) : income ? format("ParsedIncome", ParsedIncome) : format("ParsedExpense", ParsedExpense));
      } } }] });
    names.set(parser.getId(), "Parser");
    this.crew.join(parser);
    for (const name of verdictAgents) {
      const agentTools = name === "Anomaly" ? [tools.categoryStats]
        : name === "Obligations" ? [tools.upcomingObligations]
          : name === "Planner" ? [tools.budgetSnapshot, tools.upcomingObligations] : [tools.budgetSnapshot];
      const role = name === "Pace" ? "Assess spending pace and tomorrow's allowance."
        : name === "Anomaly" ? "Assess whether this expense is unusual for its category."
          : name === "Planner" ? "Plan the new budget period, considering upcoming obligations."
            : name === "Obligations" ? "Assess whether enough remains for upcoming obligations." : "Give one practical sentence of budget advice.";
      const events = name === "Obligations" ? ["period.started", "purchase.parsed"] : name === "Planner" ? ["period.started"]
        : name === "Anomaly" ? ["expense.recorded"] : ["expense.recorded", "income.recorded"];
      const agent = createAgent({ name, instruction: `${role} Use ${agentTools.map(tool => tool.name).join(" and ")}; use only supplied monetary strings. Quote monetary strings exactly as supplied; never convert or compute money. Never use minor-unit terminology. Keep headline <= 80 and reason <= 280 characters. Return the requested JSON.`,
        capabilities: [], tools: agentTools, handlers: [{ specification: new Events(events), processor: { apply: ({ event }) => {
          const data = (event.type === "purchase.parsed" ? PurchaseParsedPayload : event.type === "period.started" ? PeriodStartedPayload
            : event.type === "income.recorded" ? IncomeRecordedPayload : ExpenseRecordedPayload).parse(event.payload);
          const request = this.store.state.requests[data.requestId];
          if (!request || !this.isActive(data.requestId, request)) return;
          this.crew.startLoop(agent, data.requestId, JSON.stringify(formatMoneyFields(data)), format(`${name}Verdict`, Verdict), agent.getTools(), name === "Coach" ? "gpt-6.2-sol" : "gpt-6.1-terra");
        } } }] });
      names.set(agent.getId(), name);
      this.crew.join(agent);
    }
    const purchaseTools = createPurchaseTools(this.store);
    for (const name of [...purchaseAgents, "Judge"] as const) {
      if (name === "Obligations") continue; // One participant handles period and purchase obligations.
      const tool = name === "Impact" || name === "Judge" ? purchaseTools.simulateBudget
        : name === "Deal Check" ? purchaseTools.priceHistory : undefined;
      const roles = {
        Impact: "Assess the purchase's effect on the remaining budget.",
        Obligations: "Assess upcoming reserved obligations, using a 30-day horizon.",
        "Deal Check": "Assess the deal against synthetic 90-day price history; unknown is not evidence of a discount.",
        Alternatives: "Suggest a cheaper or deferred alternative. Do not invent prices.",
        Judge: "Judge the proposed purchase using all four adviser slots, including failures. Return buy, wait or skip, explaining uncertainty and the tool's figures. If the budget becomes negative prefer wait or skip.",
      };
      const agent = createAgent({ name, instruction: `${roles[name]} ${tool ? `Call ${tool.name}; use the purchase price as amount or item as appropriate.` : ""} Quote monetary strings exactly as supplied; never convert or compute money. Never use minor-unit terminology. Keep headline <= 80 and reason <= 280 characters. Return requested JSON.`,
        capabilities: [], tools: tool ? [tool] : [], handlers: [{
          specification: new Events([name === "Judge" ? "purchase.ready" : "purchase.parsed"]),
          processor: { apply: ({ event }) => {
            const data = name === "Judge" ? PurchaseReadyPayload.parse(event.payload) : PurchaseParsedPayload.parse(event.payload);
            const request = this.store.state.requests[data.requestId];
            if (!request || !this.isActive(data.requestId, request) || request.kind !== "purchase") return;
            this.crew.startLoop(agent, data.requestId, JSON.stringify(formatMoneyFields({ ...data, purchase: request.parsed })),
              name === "Judge" ? format("Judgement", Judgement) : format(`${name.replaceAll(" ", "")}Verdict`, Verdict),
              agent.getTools(), name === "Judge" ? "gpt-6.2-sol" : "gpt-6.1-terra");
          } },
        }] });
      names.set(agent.getId(), name);
      this.crew.join(agent);
    }
    this.unsubscribe = this.store.onReset(() => this.clear());
  }

  submit(text: string): { requestId: string } {
    if (!this.store.state.periods.some(p => p.id === this.store.state.currentPeriodId && p.status === "open")) {
      throw new ConflictException({ error: "no_open_period" });
    }
    const requestId = randomUUID();
    this.crew.sendEvent(SemanticEvent.create("expense.submitted", this.human.getId(), { requestId, text, date: this.store.state.today }), this.human.getId());
    return { requestId };
  }

  submitPurchase(text: string): { requestId: string } {
    if (!this.store.state.periods.some(p => p.id === this.store.state.currentPeriodId && p.status === "open")) {
      throw new ConflictException({ error: "no_open_period" });
    }
    const requestId = randomUUID();
    this.crew.sendEvent(SemanticEvent.create("purchase.submitted", this.human.getId(), { requestId, text, date: this.store.state.today }), this.human.getId());
    return { requestId };
  }

  submitIncome(text: string): { requestId: string } {
    const requestId = randomUUID();
    this.crew.sendEvent(SemanticEvent.create("income.submitted", this.human.getId(),
      { requestId, text, date: this.store.state.today }), this.human.getId());
    return { requestId };
  }

  beginSimulation(runId: string): void {
    this.stopSimulation();
    this.simulationId = runId;
  }

  stopSimulation(): void {
    this.crew.suppressRequests(this.simulationRequests.keys());
    this.simulationId = undefined;
    for (const requestId of this.simulationRequests.keys()) {
      const request = this.store.cancelSimulationRequest(requestId);
      if (request) this.publish({ v: 1, type: "request.cancelled", at: new Date().toISOString(), data: { requestId, request } });
      this.pending.delete(requestId);
      this.submissions.delete(requestId);
    }
    for (const loops of this.links.values()) {
      for (const [loopId, link] of loops) {
        if (!this.simulationRequests.has(link.requestId)) continue;
        clearTimeout(link.timer);
        loops.delete(loopId);
      }
    }
    this.simulationRequests.clear();
  }

  private isActive(requestId: string, request: RequestState): boolean {
    return this.store.state.requests[requestId] === request && !request.error && request.status !== "cancelled"
      && (request.source !== "sim" || (this.simulationId !== undefined && this.simulationRequests.get(requestId) === this.simulationId));
  }

  private recordParsed(link: Link, answer: unknown): void {
    if (!this.isActive(link.requestId, link.request)) return;
    const parsed = link.request.kind === "purchase" ? ParsedPurchase.parse(answer)
      : link.request.kind === "income" ? ParsedIncome.parse(answer) : ParsedExpense.parse(answer);
    if (!this.openPeriod() && link.request.source === "sim" && !("kind" in parsed && parsed.kind === "salary")) {
      // Parser completion order is independent of the accelerated calendar.
      this.pending.set(link.requestId, { link, answer: parsed });
      return;
    }
    if ("item" in parsed) {
      link.request.parsed = parsed;
      this.publish({ v: 1, type: "purchase.parsed", at: new Date().toISOString(), data: { requestId: link.requestId, purchase: parsed } });
      return;
    }
    const submitted = this.submissions.get(link.requestId)!;
    if ("kind" in parsed) {
      if (parsed.kind === "extra" && !this.openPeriod()) {
        this.failRequest(link.requestId, "no_open_period");
        return;
      }
      const previousId = this.openPeriod()?.id;
      const income = { id: randomUUID(), requestId: link.requestId, date: submitted.date, ...parsed };
      this.store.recordIncome(income);
      const period = this.openPeriod()!;
      if (parsed.kind === "salary") {
        const closed = this.store.state.periods.find(p => p.id === previousId);
        if (closed) this.publish({ v: 1, type: "period.closed", at: new Date().toISOString(),
          data: { periodId: closed.id, finalBalance: closed.finalBalance! } });
        this.publish({ v: 1, type: "period.started", at: new Date().toISOString(), data: { requestId: link.requestId, period } });
        for (const [requestId, work] of this.pending) {
          this.pending.delete(requestId);
          try { this.recordParsed(work.link, work.answer); }
          catch { this.failRequest(requestId, "invalid_parser_answer"); }
        }
      } else {
        const projectionToday = period.projection.find(p => p.date === income.date)!;
        this.publish({ v: 1, type: "income.recorded", at: new Date().toISOString(),
          data: { requestId: link.requestId, income, projectionToday, remaining: projectionToday.remaining } });
      }
    } else {
      const expense = { id: randomUUID(), requestId: link.requestId, date: submitted.date, ...parsed, source: submitted.source ?? "user" };
      this.store.recordExpense(expense);
      const projectionToday = this.openPeriod()!.projection.find(p => p.date === expense.date)!;
      this.publish({ v: 1, type: "expense.recorded", at: new Date().toISOString(),
        data: { requestId: link.requestId, expense, projectionToday, remaining: projectionToday.remaining } });
    }
  }

  private openPeriod() {
    return this.store.state.periods.find(p => p.id === this.store.state.currentPeriodId && p.status === "open");
  }

  private failRequest(requestId: string, error: string): void {
    this.store.failRequest(requestId, error);
    this.submissions.delete(requestId);
    this.publish({ v: 1, type: "request.failed", at: new Date().toISOString(), data: { requestId, error } });
  }

  private recordVerdict(link: Link, verdict: z.infer<typeof Verdict> | { status: "failed"; error: string }): void {
    if (link.agent === "Parser" || link.agent === "Judge" || link.request.verdicts[link.agent]) return;
    this.store.putVerdict(link.requestId, link.agent, verdict);
    this.publish({ v: 1, type: "verdict.recorded", at: new Date().toISOString(), data: { requestId: link.requestId, agent: link.agent, verdict } });
    if (link.request.kind === "purchase") {
      if (this.ready.has(link.request) || !purchaseAgents.every(name => link.request.verdicts[name])) return;
      this.ready.add(link.request);
      const purchase = ParsedPurchase.parse(link.request.parsed);
      const period = this.store.state.periods.find(p => p.id === this.store.state.currentPeriodId && p.status === "open");
      if (!period) {
        this.store.failRequest(link.requestId, "no_open_period");
        this.publish({ v: 1, type: "request.failed", at: new Date().toISOString(), data: { requestId: link.requestId, error: "no_open_period" } });
        return;
      }
      const data = { requestId: link.requestId, verdicts: link.request.verdicts,
        simulation: simulateBudget(period, this.store.state.today, { amount: purchase.price }) };
      this.crew.sendEvent(SemanticEvent.create("purchase.ready", this.ledgerId, data), this.ledgerId);
      return;
    }
    const expected = link.request.kind === "expense" ? expenseAgents
      : link.request.parsed && "kind" in link.request.parsed && link.request.parsed.kind === "salary" ? periodAgents : incomeAgents;
    if (expected.every(name => link.request.verdicts[name])) this.submissions.delete(link.requestId);
  }

  private publish(envelope: StateEnvelope): void {
    // Remaining is a realtime-only addition; runtime payloads stay strict.
    const data = envelope.type === "expense.recorded"
      ? { requestId: envelope.data.requestId, expense: envelope.data.expense, projectionToday: envelope.data.projectionToday }
      : envelope.type === "income.recorded"
        ? { requestId: envelope.data.requestId, income: envelope.data.income, projectionToday: envelope.data.projectionToday }
        : envelope.data;
    this.crew.sendEvent(SemanticEvent.create(envelope.type, this.ledgerId, data), this.ledgerId);
    void this.publisher.publish("crew:state", envelope).catch(() => this.logger.warn("State publication failed"));
  }

  private clear(): void {
    this.stopSimulation();
    for (const loops of this.links.values()) for (const link of loops.values()) clearTimeout(link.timer);
    this.links.clear();
    this.submissions.clear();
    this.pending.clear();
    this.ready = new WeakSet();
  }

  onModuleDestroy(): void { this.unsubscribe?.(); this.clear(); }
}
