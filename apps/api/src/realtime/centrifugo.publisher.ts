import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ActivityEnvelope, StateEnvelope } from "@budget-crew/shared";
import { ConfigService } from "../config/config.service.js";

@Injectable()
export class CentrifugoPublisher {
  private readonly logger = new Logger(CentrifugoPublisher.name);

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  async publish(channel: string, envelope: ActivityEnvelope | StateEnvelope): Promise<void> {
    try {
      const response = await fetch(
        `${this.config.env.CENTRIFUGO_API_URL.replace(/\/$/, "")}/publish`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": this.config.env.CENTRIFUGO_API_KEY ?? "",
          },
          body: JSON.stringify({ channel, data: envelope }),
        },
      );
      if (!response.ok) {
        this.logger.warn(`Centrifugo publication failed: HTTP ${response.status}`);
        if (channel === "crew:state") throw new Error("Centrifugo publication failed");
        return;
      }
      const result: unknown = await response.json();
      if (typeof result === "object" && result !== null && "error" in result) {
        this.logger.warn("Centrifugo publication failed: API error");
        if (channel === "crew:state") throw new Error("Centrifugo publication failed");
      }
    } catch {
      this.logger.warn("Centrifugo publication failed: transport or response error");
      if (channel === "crew:state") throw new Error("Centrifugo publication failed");
    }
  }
}
