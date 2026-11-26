import { randomUUID } from "node:crypto";
import { createAgent, createHuman, SituationSpecification, SemanticEvent, type SituationContext } from "@mozaik-ai/core";
import { ConflictException, Inject, Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from "@nestjs/common";
import { DayAdvancedPayload, ExpenseSubmittedPayload, ExpenseRecordedPayload, IncomeSubmittedPayload, IncomeRecordedPayload, PeriodStartedPayload, PurchaseSubmittedPayload, PurchaseParsedPayload, PurchaseReadyPayload, ParsedExpense, ParsedIncome, ParsedPurchase, Judgement, Verdict, type RequestState, type StateEnvelope } from "@budget-crew/shared";
import { z } from "zod";
import { BudgetStore } from "../budget/budget.store.js";
import { CentrifugoPublisher } from "../realtime/centrifugo.publisher.js";
import { CrewRuntime } from "./crew-runtime.js";
import { createExpenseTools, createUpcomingObligationsTool } from "./expense-tools.js";
import { createPurchaseSimulationTool, createPurchaseTools } from "./purchase-tools.js";
import { createWebSearchTool } from "./web-search.js";
import { ConfigService } from "../config/config.service.js";
import { formatMoneyFields } from "./money.js";
import { simulateBudget, upcomingObligations, type Period } from "@budget-crew/budget";

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
  private purchasePeriods = new WeakMap<RequestState, Period>();

  constructor(@Inject(CrewRuntime) private readonly crew: CrewRuntime,
    @Inject(BudgetStore) private readonly store: BudgetStore,
    @Inject(CentrifugoPublisher) private readonly publisher: CentrifugoPublisher,
    @Inject(ConfigService) private readonly config: ConfigService) {}

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
          if (kind === "purchase" && this.openPeriod()) this.purchasePeriods.set(request, structuredClone(this.openPeriod()!));
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
            }, request.kind === "purchase" ? 60_000 : 45_000);
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
    const parser = createAgent({ name: "Parser", instruction: "Amounts in the text are euros in any language or number format; return them as integer euro cents: \"bread 2.30\" -> 230, \"concert 85\" -> 8500, \"пицца 9,90\" -> 990, \"2.450,00 €\" -> 245000. One expense naming several items is their total. Category is one lowercase English word whatever the input language, such as groceries, food, transport, housing, utilities, health, entertainment, electronics, shopping or other. For expenses return amount, category and note; for incomes return amount, kind salary or extra, and source; for purchases return item, price and category. If the text states no amount or price, return 0 for it; never guess one. Return only the requested JSON. Do not invent missing details.",
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
      const agentTools = name === "Anomaly" ? [tools.categoryStats, tools.plannedArticles]
        : name === "Obligations" ? [tools.upcomingObligations]
          : name === "Planner" ? [tools.budgetSnapshot, tools.upcomingObligations] : [tools.budgetSnapshot];
      // Planned articles are deducted from the period budget before the daily allowance is computed.
      const reserved = "Planned obligations are already reserved: allowance, remaining and simulations are after them, so they need no extra money set aside.";
      const role = name === "Pace" ? "Assess spending pace and tomorrow's allowance."
        : name === "Anomaly" ? "Assess whether this expense is unusual for its category. If it looks like a planned article (rent, utilities, phone, subscriptions, transport pass), warn that the article is already reserved in the budget and recording it as spending double-counts it."
          : name === "Planner" ? `Plan the new budget period, considering upcoming obligations. ${reserved} Return ok unless the allowance is negative.`
            : name === "Obligations" ? "For period reviews assess upcoming obligations. For purchases use a 30-day horizon and the supplied obligationsCoverage.level: stop when post-purchase money cannot cover obligations, warn when the margin is under one week of today's allowance, otherwise ok. The code already computes this conservative coverage check. The supplied stored simulation is the budget; never claim balance or budget is missing." : "Give one practical sentence of budget advice.";
      const events = name === "Obligations" ? ["period.started", "purchase.parsed"] : name === "Planner" ? ["period.started"]
        : name === "Anomaly" ? ["expense.recorded"] : ["expense.recorded", "income.recorded"];
      const agent = createAgent({ name, instruction: `${role} Use ${agentTools.map(tool => tool.name).join(" and ")}; use only supplied monetary strings. Quote monetary strings exactly as supplied; never convert or compute money. Never use minor-unit terminology. Keep headline <= 80 and reason <= 280 characters. Return the requested JSON.`,
        capabilities: [], tools: agentTools, handlers: [{ specification: new Events(events), processor: { apply: ({ event }) => {
          const data = (event.type === "purchase.parsed" ? PurchaseParsedPayload : event.type === "period.started" ? PeriodStartedPayload
            : event.type === "income.recorded" ? IncomeRecordedPayload : ExpenseRecordedPayload).parse(event.payload);
          const request = this.store.state.requests[data.requestId];
          if (!request || !this.isActive(data.requestId, request)) return;
          const purchase = event.type === "purchase.parsed";
          const period = purchase ? this.purchasePeriods.get(request) : undefined;
          this.crew.startLoop(agent, data.requestId, JSON.stringify(formatMoneyFields(purchase ? this.purchaseContext(request, data) : data)),
            format(`${name}Verdict`, Verdict), period
              ? [createUpcomingObligationsTool(() => ({ period, today: request.date! }))] : agent.getTools(),
            name === "Coach" ? "gpt-6.2-sol" : "gpt-6.1-terra");
        } } }] });
      names.set(agent.getId(), name);
      this.crew.join(agent);
    }
    const purchaseTools = createPurchaseTools(this.store);
    for (const name of [...purchaseAgents, "Judge"] as const) {
      if (name === "Obligations") continue; // One participant handles period and purchase obligations.
      const tool = name === "Deal Check" ? purchaseTools.priceHistory : undefined;
      const roles = {
        Impact: "Assess the purchase's effect on the remaining budget. Call simulate_budget with the purchase price as amount. The stored simulation is the only source of budget figures.",
        "Deal Check": "Call price_history for the synthetic 90-day history and web_search for a current web price of the requested item. Compare both with the asked price, explicitly labelling synthetic history versus current web sources; unknown history is not evidence of a discount. Set the level from the price alone; budget impact is Impact's slot.",
        Alternatives: "Call web_search to find one concrete cheaper option or a better time to buy, naming the option or time and its sourced euro price. Assess whether it is worthwhile given the stored simulation's nextAllowance before/after and deltaPerDay. The supplied simulation is the budget; never claim budget or balance is unknown. If nextAllowance is absent this is the final period day, not missing budget. Do not invent prices.",
        Judge: "Judge the proposed purchase using all four adviser slots, including failures. Call simulate_budget with the purchase price as amount. The stored simulation is the only source of budget figures; planned obligations are already reserved in it, and missing account balances are not a reason to wait. Decide: skip if the simulation goes negative; wait if Deal Check shows a lower recent price than asked, or the next allowance after the purchase is less than half of before; otherwise buy. Explain uncertainty and quote the stored figures.",
      };
      const sources = name === "Deal Check" || name === "Alternatives"
        ? ' Include at most two source figures as {label:"Source",value:"<domain> €<price>"} using only search results. If search is unavailable or limited, say so and do not invent a current price or source.' : "";
      const agent = createAgent({ name, instruction: `${roles[name]}${sources} ${tool ? `Call ${tool.name}; use the purchase price as amount or item as appropriate.` : ""} Quote monetary strings exactly as supplied; never convert or compute money. Never use minor-unit terminology. Keep headline <= 80 and reason <= 280 characters. Return requested JSON.`,
        capabilities: [], tools: tool ? [tool] : [], handlers: [{
          specification: new Events([name === "Judge" ? "purchase.ready" : "purchase.parsed"]),
          processor: { apply: ({ event }) => {
            const data = name === "Judge" ? PurchaseReadyPayload.parse(event.payload) : PurchaseParsedPayload.parse(event.payload);
            const request = this.store.state.requests[data.requestId];
            if (!request || !this.isActive(data.requestId, request) || request.kind !== "purchase") return;
            this.crew.startLoop(agent, data.requestId, JSON.stringify(formatMoneyFields(name === "Alternatives"
              ? this.purchaseContext(request, data) : { ...data, purchase: request.parsed })),
              name === "Judge" ? format("Judgement", Judgement) : format(`${name.replaceAll(" ", "")}Verdict`, Verdict),
              name === "Impact" || name === "Judge" ? [createPurchaseSimulationTool(request)]
                : [...agent.getTools(), createWebSearchTool({
                  mode: this.config.env.INFERENCE, apiKey: this.config.env.OPENAI_API_KEY,
                  baseURL: this.config.env.OPENAI_BASE_URL, warn: message => this.logger.warn(message),
                })],
              name === "Judge" ? "gpt-6.2-sol" : "gpt-6.1-terra");
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
    // The parser returns 0 when the text states no amount; a crew must never cost or approve a guess.
    if (("item" in parsed ? parsed.price : parsed.amount) === 0) {
      this.failRequest(link.requestId, "missing_amount");
      return;
    }
    if (!this.openPeriod() && !this.purchasePeriods.has(link.request) && link.request.source === "sim" && !("kind" in parsed && parsed.kind === "salary")) {
      // Parser completion order is independent of the accelerated calendar.
      this.pending.set(link.requestId, { link, answer: parsed });
      return;
    }
    if ("item" in parsed) {
      // Simulator purchases without a period wait for salary; otherwise use the submission snapshot.
      const period = this.purchasePeriods.get(link.request) ?? structuredClone(this.openPeriod());
      if (!period) { this.failRequest(link.requestId, "no_open_period"); return; }
      link.request.simulation = simulateBudget(period, link.request.date!, { amount: parsed.price });
      this.purchasePeriods.set(link.request, period);
      link.request.parsed = parsed;
      this.publish({ v: 1, type: "purchase.parsed", at: new Date().toISOString(),
        data: { requestId: link.requestId, purchase: parsed, simulation: link.request.simulation } });
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

  private purchaseContext(request: RequestState, data: object) {
    const simulation = request.simulation!;
    const period = this.purchasePeriods.get(request)!;
    const obligations = upcomingObligations(period, request.date!, 30);
    const margin = simulation.remaining.after - obligations.total;
    const weekAllowance = simulation.todayAllowance.before * 7;
    return { ...data, purchase: request.parsed, simulation,
      obligationsCoverage: {
        horizonDays: 30, total: obligations.total, remainingAfterPurchaseAndObligations: margin, weekAllowance,
        level: margin < 0 ? "stop" : margin < weekAllowance ? "warn" : "ok",
      } };
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
      const data = { requestId: link.requestId, verdicts: link.request.verdicts,
        simulation: link.request.simulation! };
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
    this.purchasePeriods = new WeakMap();
    this.ready = new WeakSet();
  }

  onModuleDestroy(): void { this.unsubscribe?.(); this.clear(); }
}
