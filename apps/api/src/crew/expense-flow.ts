import { randomUUID } from "node:crypto";
import { createAgent, createHuman, SituationSpecification, SemanticEvent, type SituationContext } from "@mozaik-ai/core";
import { ConflictException, Inject, Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from "@nestjs/common";
import { ExpenseSubmittedPayload, ExpenseRecordedPayload, ParsedExpense, Verdict, type RequestState, type StateEnvelope } from "@budget-crew/shared";
import { z } from "zod";
import { BudgetStore } from "../budget/budget.store.js";
import { CentrifugoPublisher } from "../realtime/centrifugo.publisher.js";
import { CrewRuntime } from "./crew-runtime.js";
import { createExpenseTools } from "./expense-tools.js";

class Events extends SituationSpecification {
  constructor(private readonly types: readonly string[]) { super(); }
  isSatisfiedBy({ event }: SituationContext): boolean { return this.types.includes(event.type); }
}
const verdictAgents = ["Pace", "Anomaly", "Coach"] as const;
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
      specification: new Events(["expense.submitted", "message_received.started", "model.answer"]),
      processor: { apply: ({ event }) => {
        if (event.type === "expense.submitted") {
          const data = ExpenseSubmittedPayload.parse(event.payload);
          if (this.store.state.requests[data.requestId]) return;
          this.store.beginRequest(data.requestId, "expense", data.text);
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
            const parsed = ParsedExpense.parse(answer);
            const submitted = this.submissions.get(link.requestId)!;
            const expense = { id: randomUUID(), requestId: link.requestId, date: submitted.date, ...parsed, source: "user" as const };
            this.store.recordExpense(expense);
            const period = this.store.state.periods.find(p => p.id === this.store.state.currentPeriodId)!;
            const projectionToday = period.projection.find(p => p.date === expense.date)!;
            this.publish({ v: 1, type: "expense.recorded", at: new Date().toISOString(),
              data: { requestId: link.requestId, expense, projectionToday, remaining: projectionToday.remaining } });
          } else {
            this.recordVerdict(link, Verdict.parse(answer));
          }
        } catch {
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
    const parser = createAgent({ name: "Parser", instruction: "Extract the expense as integer euro cents, category and note. Return only the requested JSON. Do not invent missing details.",
      capabilities: [], tools: [], handlers: [{ specification: new Events(["expense.submitted"]), processor: { apply: ({ event }) => {
        const data = ExpenseSubmittedPayload.parse(event.payload);
        this.crew.startLoop(parser, data.requestId, data.text, format("ParsedExpense", ParsedExpense));
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

  private recordVerdict(link: Link, verdict: z.infer<typeof Verdict> | { status: "failed"; error: string }): void {
    if (link.agent === "Parser" || link.request.verdicts[link.agent]) return;
    this.store.putVerdict(link.requestId, link.agent, verdict);
    this.publish({ v: 1, type: "verdict.recorded", at: new Date().toISOString(), data: { requestId: link.requestId, agent: link.agent, verdict } });
    if (verdictAgents.every(name => link.request.verdicts[name])) this.submissions.delete(link.requestId);
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
  }

  onModuleDestroy(): void { this.unsubscribe?.(); this.clear(); }
}
