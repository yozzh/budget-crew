import { randomUUID } from "node:crypto";
import { createAgent, createHuman, SituationSpecification, SemanticEvent, type SituationContext } from "@mozaik-ai/core";
import { ConflictException, Inject, Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from "@nestjs/common";
import { ExpenseSubmittedPayload, ExpenseRecordedPayload, IncomeSubmittedPayload, IncomeRecordedPayload, PeriodStartedPayload, ParsedExpense, ParsedIncome, Verdict, type RequestState, type StateEnvelope } from "@budget-crew/shared";
import { z } from "zod";
import { BudgetStore } from "../budget/budget.store.js";
import { CentrifugoPublisher } from "../realtime/centrifugo.publisher.js";
import { CrewRuntime } from "./crew-runtime.js";
import { createExpenseTools } from "./expense-tools.js";

class Events extends SituationSpecification {
  constructor(private readonly types: readonly string[]) { super(); }
  isSatisfiedBy({ event }: SituationContext): boolean { return this.types.includes(event.type); }
}
const expenseAgents = ["Pace", "Anomaly", "Coach"] as const;
const incomeAgents = ["Pace", "Coach"] as const;
const periodAgents = ["Planner", "Obligations"] as const;
const verdictAgents = [...expenseAgents, ...periodAgents] as const;
type VerdictAgent = typeof verdictAgents[number];
type Link = { requestId: string; request: RequestState; agent: "Parser" | VerdictAgent; timer?: NodeJS.Timeout };
const format = (name: string, schema: z.ZodType) => ({ name, schema: z.toJSONSchema(schema), strict: true });

@Injectable()
export class ExpenseFlow implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExpenseFlow.name);
  private readonly human = createHuman({ name: "Human", capabilities: [], handlers: [] });
  private readonly links = new Map<string, Map<string, Link>>();
  private readonly submissions = new Map<string, z.infer<typeof ExpenseSubmittedPayload>>();
  private unsubscribe?: () => void;
  private ledgerId = "";

  constructor(@Inject(CrewRuntime) private readonly crew: CrewRuntime,
    @Inject(BudgetStore) private readonly store: BudgetStore,
    @Inject(CentrifugoPublisher) private readonly publisher: CentrifugoPublisher) {}

  onModuleInit(): void {
    const tools = createExpenseTools(this.store);
    const names = new Map<string, Link["agent"]>();
    const ledger = createHuman({ name: "Ledger", capabilities: [], handlers: [{
      specification: new Events(["expense.submitted", "income.submitted", "message_received.started", "model.answer"]),
      processor: { apply: ({ event }) => {
        if (event.type === "expense.submitted" || event.type === "income.submitted") {
          const data = (event.type === "income.submitted" ? IncomeSubmittedPayload : ExpenseSubmittedPayload).parse(event.payload);
          if (this.store.state.requests[data.requestId]) return;
          this.store.beginRequest(data.requestId, event.type === "income.submitted" ? "income" : "expense", data.text);
          this.submissions.set(data.requestId, data);
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
          if (!requestId || !request || !this.submissions.has(requestId)) return;
          if (!loops) { loops = new Map(); this.links.set(event.producerId, loops); }
          const link: Link = { requestId, request, agent };
          loops.set(payload.loopId, link);
          if (agent !== "Parser") {
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
            const submitted = this.submissions.get(link.requestId)!;
            if (link.request.kind === "income") {
              const parsed = ParsedIncome.parse(answer);
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
                this.publish({ v: 1, type: "period.started", at: new Date().toISOString(),
                  data: { requestId: link.requestId, period } });
              } else {
                const projectionToday = period.projection.find(p => p.date === income.date)!;
                this.publish({ v: 1, type: "income.recorded", at: new Date().toISOString(),
                  data: { requestId: link.requestId, income, projectionToday, remaining: projectionToday.remaining } });
              }
            } else {
              const parsed = ParsedExpense.parse(answer);
              const expense = { id: randomUUID(), requestId: link.requestId, date: submitted.date, ...parsed, source: "user" as const };
              this.store.recordExpense(expense);
              const projectionToday = this.openPeriod()!.projection.find(p => p.date === expense.date)!;
              this.publish({ v: 1, type: "expense.recorded", at: new Date().toISOString(),
                data: { requestId: link.requestId, expense, projectionToday, remaining: projectionToday.remaining } });
            }
          } else {
            this.recordVerdict(link, Verdict.parse(answer));
          }
        } catch {
          if (agent === "Parser") {
            this.failRequest(link.requestId, "invalid_parser_answer");
          } else this.recordVerdict(link, { status: "failed", error: "invalid_verdict" });
        }
      } },
    }] });
    this.ledgerId = ledger.getId();
    this.crew.join(ledger);
    this.crew.join(this.human);
    const parser = createAgent({ name: "Parser", instruction: "Extract integer euro cents. For expenses return category and note; for incomes return kind salary or extra, and source. Return only the requested JSON. Do not invent missing details.",
      capabilities: [], tools: [], handlers: [{ specification: new Events(["expense.submitted", "income.submitted"]), processor: { apply: ({ event }) => {
        const data = ExpenseSubmittedPayload.parse(event.payload);
        const income = event.type === "income.submitted";
        this.crew.startLoop(parser, data.requestId, `${income ? "Income" : "Expense"}: ${data.text}`,
          income ? format("ParsedIncome", ParsedIncome) : format("ParsedExpense", ParsedExpense));
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
      const events = name === "Planner" || name === "Obligations" ? ["period.started"]
        : name === "Anomaly" ? ["expense.recorded"] : ["expense.recorded", "income.recorded"];
      const agent = createAgent({ name, instruction: `${role} Use ${agentTools.map(tool => tool.name).join(" and ")}; use only tool numbers, never compute money. Keep headline <= 80 and reason <= 280 characters. Return the requested JSON.`,
        capabilities: [], tools: agentTools, handlers: [{ specification: new Events(events), processor: { apply: ({ event }) => {
          const data = (event.type === "period.started" ? PeriodStartedPayload
            : event.type === "income.recorded" ? IncomeRecordedPayload : ExpenseRecordedPayload).parse(event.payload);
          this.crew.startLoop(agent, data.requestId, JSON.stringify(data), format(`${name}Verdict`, Verdict), agent.getTools(), name === "Coach" ? "gpt-6.2-sol" : "gpt-6.1-terra");
        } } }] });
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

  submitIncome(text: string): { requestId: string } {
    const requestId = randomUUID();
    this.crew.sendEvent(SemanticEvent.create("income.submitted", this.human.getId(),
      { requestId, text, date: this.store.state.today }), this.human.getId());
    return { requestId };
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
    if (link.agent === "Parser" || link.request.verdicts[link.agent]) return;
    this.store.putVerdict(link.requestId, link.agent, verdict);
    this.publish({ v: 1, type: "verdict.recorded", at: new Date().toISOString(), data: { requestId: link.requestId, agent: link.agent, verdict } });
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
    for (const loops of this.links.values()) for (const link of loops.values()) clearTimeout(link.timer);
    this.links.clear();
    this.submissions.clear();
  }

  onModuleDestroy(): void { this.unsubscribe?.(); this.clear(); }
}
