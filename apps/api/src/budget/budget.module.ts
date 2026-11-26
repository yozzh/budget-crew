import { Module } from "@nestjs/common";
import { BudgetStore } from "./budget.store.js";
import { BudgetController } from "./budget.controller.js";
import { RealtimeModule } from "../realtime/realtime.module.js";

@Module({ imports: [RealtimeModule], providers: [BudgetStore], controllers: [BudgetController], exports: [BudgetStore] })
export class BudgetModule {}
