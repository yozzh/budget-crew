import { Module } from "@nestjs/common";
import { InferenceModule } from "../inference/inference.module.js";
import { RealtimeModule } from "../realtime/realtime.module.js";
import { CrewRuntime } from "./crew-runtime.js";
import { BudgetModule } from "../budget/budget.module.js";

@Module({ imports: [InferenceModule, RealtimeModule, BudgetModule], providers: [CrewRuntime], exports: [CrewRuntime] })
export class CrewModule {}
