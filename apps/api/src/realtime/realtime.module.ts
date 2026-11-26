import { Module } from "@nestjs/common";
import { CentrifugoPublisher } from "./centrifugo.publisher.js";

@Module({
  providers: [CentrifugoPublisher],
  exports: [CentrifugoPublisher],
})
export class RealtimeModule {}
