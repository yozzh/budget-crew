import { Controller, Get, HttpCode, Inject, Post } from "@nestjs/common";
import type { StateResponse } from "@budget-crew/shared";
import { BudgetStore } from "./budget.store.js";
import { CentrifugoPublisher } from "../realtime/realtime.module.js";

@Controller()
export class BudgetController {
  constructor(@Inject(BudgetStore) private readonly store: BudgetStore,
    @Inject(CentrifugoPublisher) private readonly publisher: CentrifugoPublisher) {}

  @Get("state")
  getState(): StateResponse { return this.store.snapshot(50); }

  @Post("reset")
  @HttpCode(204)
  async reset(): Promise<void> {
    this.store.reset();
    await this.publisher.publish("crew:state", { v: 1, type: "state.reset", at: new Date().toISOString(), data: {} });
  }
}
