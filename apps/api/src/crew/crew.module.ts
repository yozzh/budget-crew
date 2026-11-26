import { Module } from "@nestjs/common";
import { InferenceModule } from "../inference/inference.module.js";
import { RealtimeModule } from "../realtime/realtime.module.js";
import { CrewRuntime } from "./crew-runtime.js";
import { BudgetModule } from "../budget/budget.module.js";
import { ExpenseFlow } from "./expense-flow.js";
import { ExpenseController } from "./expense.controller.js";
import { IncomeController } from "./income.controller.js";

@Module({ imports: [InferenceModule, RealtimeModule, BudgetModule],
  providers: [CrewRuntime, ExpenseFlow], controllers: [ExpenseController, IncomeController], exports: [CrewRuntime] })
export class CrewModule {}
