import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHuman, SemanticEvent } from "@mozaik-ai/core";
import { ConflictException, Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { SimulationMonth, type BudgetStateSnapshot, type StateEnvelope } from "@budget-crew/shared";
import { BudgetStore } from "../budget/budget.store.js";
import { CentrifugoPublisher } from "../realtime/centrifugo.publisher.js";
import { CrewRuntime } from "./crew-runtime.js";
import { ExpenseFlow } from "./expense-flow.js";

/** A clock-driven runtime participant, never an inference agent. */
@Injectable()
export class Simulator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(Simulator.name);
  private readonly participant = createHuman({ name: "Simulator", capabilities: [], handlers: [] });
  private readonly month: SimulationMonth;
  private timer?: NodeJS.Timeout;
  private runId?: string;
  private unsubscribe?: () => void;

  constructor(@Inject(CrewRuntime) private readonly crew: CrewRuntime,
    @Inject(ExpenseFlow) private readonly flow: ExpenseFlow,
    @Inject(BudgetStore) private readonly store: BudgetStore,
    @Inject(CentrifugoPublisher) private readonly publisher: CentrifugoPublisher) {
    const paths = [new URL("../../../../seed/month.json", import.meta.url), new URL("../../seed/month.json", import.meta.url)];
    const path = paths.find(url => existsSync(fileURLToPath(url)));
    if (!path) throw new Error("Synthetic month seed not found");
    this.month = SimulationMonth.parse(JSON.parse(readFileSync(path, "utf8")));
  }

  onModuleInit(): void {
    this.crew.join(this.participant);
    this.unsubscribe = this.store.onReset(() => this.cancel());
  }

  start(speed = 4): BudgetStateSnapshot["simulation"] {
    if (this.store.state.simulation.running) throw new ConflictException({ error: "simulation_running" });
    this.store.reset(this.month.days[0]!.date, { openPeriod: false });
    const runId = randomUUID();
    this.runId = runId;
    this.flow.beginSimulation(runId);
    this.store.state.simulation = { running: true, speed };
    this.publish({ v: 1, type: "state.reset", at: new Date().toISOString(), data: {} });
    this.advance(runId, 0, speed);
    return { ...this.store.state.simulation };
  }

  stop(): void {
    const { day, speed } = this.store.state.simulation;
    const hadRun = this.runId !== undefined;
    this.cancel();
    if (hadRun && day) this.publish({ v: 1, type: "simulation.tick", at: new Date().toISOString(), data: { day, running: false, speed } });
  }

  private advance(runId: string, index: number, speed: number): void {
    if (this.runId !== runId) return;
    this.timer = undefined;
    const day = this.month.days[index]!;
    this.store.state.simulation = { running: true, day: day.date, speed };
    const senderId = this.participant.getId();
    this.crew.sendEvent(SemanticEvent.create("day.advanced", senderId, { day: day.date, runId }), senderId);
    // Submission dates belong to the clock tick, not to eventual parser completion.
    for (const [kind, texts] of [["income", day.incomes], ["expense", day.expenses], ["purchase", day.purchases]] as const) {
      for (const text of texts) this.crew.sendEvent(SemanticEvent.create(`${kind}.submitted`, senderId,
        { requestId: randomUUID(), text, date: day.date, source: "sim", runId }), senderId);
    }
    this.publish({ v: 1, type: "simulation.tick", at: new Date().toISOString(), data: { day: day.date, running: true, speed } });
    if (index + 1 === this.month.days.length) {
      this.store.state.simulation.running = false;
      this.publish({ v: 1, type: "simulation.finished", at: new Date().toISOString(), data: { day: day.date, running: false, speed } });
      return;
    }
    this.timer = setTimeout(() => this.advance(runId, index + 1, speed), speed * 1000);
  }

  private cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.runId = undefined;
    this.flow.stopSimulation();
    this.store.state.simulation.running = false;
  }

  private publish(envelope: StateEnvelope): void {
    const senderId = this.participant.getId();
    this.crew.sendEvent(SemanticEvent.create(envelope.type, senderId, envelope.data), senderId);
    void this.publisher.publish("crew:state", envelope).catch(() => this.logger.warn("State publication failed"));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.cancel();
  }
}
