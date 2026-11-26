import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "../config/config.service.js";

export const DEMO_CLOCK = Symbol("DEMO_CLOCK");
export type RequestSource = "user" | "sim";
export type RequestRoute = Readonly<{ mode: "live" | "stub"; reason?: "replay" | "limit" }>;

const hour = 60 * 60 * 1000;
const day = 24 * hour;
const live: RequestRoute = Object.freeze({ mode: "live" });
const stub: RequestRoute = Object.freeze({ mode: "stub" });
const replay: RequestRoute = Object.freeze({ mode: "stub", reason: "replay" });
const limited: RequestRoute = Object.freeze({ mode: "stub", reason: "limit" });

/** Process-local admission counters deliberately live outside the resettable budget store. */
@Injectable()
export class DemoPolicy {
  private readonly admissions = new Map<string, number[]>();
  private utcDay = -1;
  private dailyAdmissions = 0;

  constructor(@Inject(ConfigService) private readonly config: ConfigService,
    @Inject(DEMO_CLOCK) private readonly now: () => number) {}

  choose(source: RequestSource, ip: string): RequestRoute {
    const env = this.config.env;
    if (!env.PUBLIC_DEMO) return env.INFERENCE === "live" ? live : stub;
    if (source === "sim") return replay;
    if (env.INFERENCE === "stub") return stub;

    const now = this.now();
    const utcDay = Math.floor(now / day);
    if (utcDay !== this.utcDay) {
      this.utcDay = utcDay;
      this.dailyAdmissions = 0;
    }
    // Retain only the rolling hour, including across UTC midnight, and discard inactive IPs.
    for (const [address, timestamps] of this.admissions) {
      let expired = 0;
      while (expired < timestamps.length && timestamps[expired]! <= now - hour) expired++;
      if (expired === timestamps.length) this.admissions.delete(address);
      else if (expired > 0) timestamps.splice(0, expired);
    }
    const timestamps = this.admissions.get(ip);
    if (this.dailyAdmissions >= env.LIVE_LIMIT_PER_DAY
      || (timestamps?.length ?? 0) >= env.LIVE_LIMIT_PER_IP_PER_HOUR) return limited;

    // No await between checking and reserving both limits: one admission per user request.
    if (timestamps) timestamps.push(now);
    else this.admissions.set(ip, [now]);
    this.dailyAdmissions++;
    return live;
  }
}
