import { Injectable, Module } from "@nestjs/common";
import type { StateEnvelope } from "@budget-crew/shared";

@Injectable()
export class CentrifugoPublisher {
  async publish(channel: "crew:state", data: StateEnvelope): Promise<void> {
    const url = process.env.CENTRIFUGO_API_URL;
    const key = process.env.CENTRIFUGO_API_KEY ?? process.env.CENTRIFUGO_HTTP_API_KEY;
    if (!url || !key) throw new Error("Centrifugo API URL and key are required for publication");
    const response = await fetch(`${url.replace(/\/$/, "")}/publish`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": key },
      body: JSON.stringify({ channel, data }),
    });
    if (!response.ok) throw new Error(`Centrifugo publish failed: HTTP ${response.status}`);
    const result = await response.json() as { error?: { code: number; message: string } };
    if (result.error) throw new Error(`Centrifugo publish failed: ${result.error.code} ${result.error.message}`);
  }
}

@Module({ providers: [CentrifugoPublisher], exports: [CentrifugoPublisher] })
export class RealtimeModule {}
