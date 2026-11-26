import { randomUUID } from "node:crypto";
import { createAgent, createHuman, SituationSpecification, SemanticEvent, type SituationContext } from "@mozaik-ai/core";
import { ConflictException, Inject, Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from "@nestjs/common";
import { ExpenseSubmittedPayload, ExpenseRecordedPayload, PurchaseSubmittedPayload, PurchaseParsedPayload, PurchaseReadyPayload, ParsedExpense, ParsedPurchase, Judgement, Verdict, type RequestState, type StateEnvelope } from "@budget-crew/shared";
import { z } from "zod";
import { BudgetStore } from "../budget/budget.store.js";
import { CentrifugoPublisher } from "../realtime/centrifugo.publisher.js";
import { CrewRuntime } from "./crew-runtime.js";
import { createExpenseTools } from "./expense-tools.js";
import { createPurchaseTools } from "./purchase-tools.js";
import { simulateBudget } from "@budget-crew/budget";

class Events extends SituationSpecification {
  constructor(private readonly types: readonly string[]) { super(); }
  isSatisfiedBy({ event }: SituationContext): boolean { return this.types.includes(event.type); }
}
const verdictAgents = ["Pace", "Anomaly", "Coach"] as const;
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

  constructor(@Inject(CrewRuntime) private readonly crew: CrewRuntime,
    @Inject(BudgetStore) private readonly store: BudgetStore,
    @Inject(CentrifugoPublisher) private readonly publisher: CentrifugoPublisher) {}

  onModuleInit(): void {
    const tools = createExpenseTools(this.store);
    const names = new Map<string, Link["agent"]>();
    const ledger = createHuman({ name: "Ledger", capabilities: [], handlers: [{
      specification: new Events(["expense.submitted", "purchase.submitted", "message_received.started", "model.answer"]),
      processor: { apply: ({ event }) => {
        if (event.type === "expense.submitted" || event.type === "purchase.submitted") {
          const data = event.type === "expense.submitted" ? ExpenseSubmittedPayload.parse(event.payload) : PurchaseSubmittedPayload.parse(event.payload);
          if (this.store.state.requests[data.requestId]) return;
          this.store.beginRequest(data.requestId, event.type === "expense.submitted" ? "expense" : "purchase", data.text);
          if (event.type === "expense.submitted") this.submissions.set(data.requestId, ExpenseSubmittedPayload.parse(event.payload));
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
          if (!requestId || !request || request.error || (request.kind !== "purchase" && !this.submissions.has(requestId))) return;
          if (!loops) { loops = new Map(); this.links.set(event.producerId, loops); }
          const link: Link = { requestId, request, agent };
          loops.set(payload.loopId, link);
          if (agent !== "Parser" && agent !== "Judge") {
            const loopId = payload.loopId;
            link.timer = setTimeout(() => {
              loops!.delete(loopId);
              if (this.store.state.requests[link.requestId] === link.request) this.recordVerdict(link, { status: "failed", error: "timeout" });
            }, 45_000);
          }
          return;
        }
        const link = loops?.get(payload.loopId);
        if (!link) return;
        loops!.delete(payload.loopId);
        clearTimeout(link.timer);
        if (this.store.state.requests[link.requestId] !== link.request) return;
        try {
          const answer: unknown = JSON.parse(payload.answer?.content?.text ?? "");
          if (agent === "Parser") {
            if (link.request.parsed || link.request.error) return;
            if (link.request.kind === "purchase") {
              const purchase = ParsedPurchase.parse(answer);
              link.request.parsed = purchase;
              this.publish({ v: 1, type: "purchase.parsed", at: new Date().toISOString(), data: { requestId: link.requestId, purchase } });
              return;
            }
            const parsed = ParsedExpense.parse(answer);
            const submitted = this.submissions.get(link.requestId)!;
            const expense = { id: randomUUID(), requestId: link.requestId, date: submitted.date, ...parsed, source: "user" as const };
            this.store.recordExpense(expense);
            const period = this.store.state.periods.find(p => p.id === this.store.state.currentPeriodId)!;
            const projectionToday = period.projection.find(p => p.date === expense.date)!;
            this.publish({ v: 1, type: "expense.recorded", at: new Date().toISOString(),
              data: { requestId: link.requestId, expense, projectionToday, remaining: projectionToday.remaining } });
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
            this.store.failRequest(link.requestId, "invalid_parser_answer");
            this.submissions.delete(link.requestId);
            this.publish({ v: 1, type: "request.failed", at: new Date().toISOString(),
              data: { requestId: link.requestId, error: "invalid_parser_answer" } });
          } else this.recordVerdict(link, { status: "failed", error: "invalid_verdict" });
        }
      } },
    }] });
    this.ledgerId = ledger.getId();
    this.crew.join(ledger);
    this.crew.join(this.human);
    const parser = createAgent({ name: "Parser", instruction: "Extract the expense (amount, category, note) or proposed purchase (item, price, category) according to the requested schema. Money is integer euro cents. Return only the requested JSON. Do not invent missing details.",
      capabilities: [], tools: [], handlers: [{ specification: new Events(["expense.submitted", "purchase.submitted"]), processor: { apply: ({ event }) => {
        const purchase = event.type === "purchase.submitted";
        const data = purchase ? PurchaseSubmittedPayload.parse(event.payload) : ExpenseSubmittedPayload.parse(event.payload);
        this.crew.startLoop(parser, data.requestId, data.text, purchase ? format("ParsedPurchase", ParsedPurchase) : format("ParsedExpense", ParsedExpense));
      } } }] });
    names.set(parser.getId(), "Parser");
    this.crew.join(parser);
    for (const name of verdictAgents) {
      const tool = name === "Anomaly" ? tools.categoryStats : tools.budgetSnapshot;
      const role = name === "Pace" ? "Assess spending pace and tomorrow's allowance." : name === "Anomaly" ? "Assess whether this expense is unusual for its category." : "Give one practical sentence of budget advice.";
      const agent = createAgent({ name, instruction: `${role} Call ${tool.name}; use only the tool's numbers, never compute money. Keep headline <= 80 and reason <= 280 characters. Return the requested JSON.`,
        capabilities: [], tools: [tool], handlers: [{ specification: new Events(["expense.recorded"]), processor: { apply: ({ event }) => {
          const data = ExpenseRecordedPayload.parse(event.payload);
          this.crew.startLoop(agent, data.requestId, JSON.stringify(data), format(`${name}Verdict`, Verdict), agent.getTools(), name === "Coach" ? "gpt-6.2-sol" : "gpt-6.1-terra");
        } } }] });
      names.set(agent.getId(), name);
      this.crew.join(agent);
    }
    const purchaseTools = createPurchaseTools(this.store);
    for (const name of [...purchaseAgents, "Judge"] as const) {
      const tool = name === "Impact" || name === "Judge" ? purchaseTools.simulateBudget
        : name === "Obligations" ? purchaseTools.upcomingObligations
        : name === "Deal Check" ? purchaseTools.priceHistory : undefined;
      const roles = {
        Impact: "Assess the purchase's effect on the remaining budget.",
        Obligations: "Assess upcoming reserved obligations, using a 30-day horizon.",
        "Deal Check": "Assess the deal against synthetic 90-day price history; unknown is not evidence of a discount.",
        Alternatives: "Suggest a cheaper or deferred alternative. Do not invent prices.",
        Judge: "Judge the proposed purchase using all four adviser slots, including failures. Return buy, wait or skip, explaining uncertainty and the tool's figures. If the budget becomes negative prefer wait or skip.",
      };
      const agent = createAgent({ name, instruction: `${roles[name]} ${tool ? `Call ${tool.name}; use the purchase price as amount or item as appropriate. Use only tool numbers; never compute money.` : ""} Keep headline <= 80 and reason <= 280 characters. Return requested JSON.`,
        capabilities: [], tools: tool ? [tool] : [], handlers: [{
          specification: new Events([name === "Judge" ? "purchase.ready" : "purchase.parsed"]),
          processor: { apply: ({ event }) => {
            const data = name === "Judge" ? PurchaseReadyPayload.parse(event.payload) : PurchaseParsedPayload.parse(event.payload);
            const request = this.store.state.requests[data.requestId];
            if (!request || request.error || request.kind !== "purchase") return;
            this.crew.startLoop(agent, data.requestId, JSON.stringify({ ...data, purchase: request.parsed }),
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
    this.crew.sendEvent(SemanticEvent.create("purchase.submitted", this.human.getId(), { requestId, text }), this.human.getId());
    return { requestId };
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
    } else if (verdictAgents.every(name => link.request.verdicts[name])) this.submissions.delete(link.requestId);
  }

  private publish(envelope: StateEnvelope): void {
    // Remaining is a realtime-only addition; runtime payloads stay strict.
    const data = envelope.type === "expense.recorded"
      ? { requestId: envelope.data.requestId, expense: envelope.data.expense, projectionToday: envelope.data.projectionToday }
      : envelope.data;
    this.crew.sendEvent(SemanticEvent.create(envelope.type, this.ledgerId, data), this.ledgerId);
    void this.publisher.publish("crew:state", envelope).catch(() => this.logger.warn("State publication failed"));
  }

  private clear(): void {
    for (const loops of this.links.values()) for (const link of loops.values()) clearTimeout(link.timer);
    this.links.clear();
    this.submissions.clear();
    this.ready = new WeakSet();
  }

  onModuleDestroy(): void { this.unsubscribe?.(); this.clear(); }
}
