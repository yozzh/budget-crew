import { Module } from "@nestjs/common";
import { InferenceModule } from "../inference/inference.module.js";
import { RealtimeModule } from "../realtime/realtime.module.js";
import { CrewRuntime } from "./crew-runtime.js";

@Module({ imports: [InferenceModule, RealtimeModule], providers: [CrewRuntime], exports: [CrewRuntime] })
export class CrewModule {}
