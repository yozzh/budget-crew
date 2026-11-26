import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { ConfigService, configSchema } from "../config/config.service.js";
import { DemoPolicy } from "./demo-policy.js";

function setup(overrides: Record<string, unknown> = {}, initial = Date.UTC(2026, 10, 26, 12)) {
  const config: ConfigService = { env: configSchema.parse({
    INFERENCE: "live", OPENAI_API_KEY: "offline", PUBLIC_DEMO: true,
    LIVE_LIMIT_PER_IP_PER_HOUR: 2, LIVE_LIMIT_PER_DAY: 3, ...overrides,
  }) };
  let now = initial;
  const clock = vi.fn(() => now);
  return { policy: new DemoPolicy(config, clock), clock, setTime: (time: number) => { now = time; }, initial };
}

describe("DemoPolicy", () => {
  it("atomically reserves one slot per admitted request across IP and global caps", () => {
    const { policy } = setup();
    const decisions = Array.from({ length: 5 }, () => policy.choose("user", "ip-a"));
    expect(decisions.map((choice) => choice.mode)).toEqual(["live", "live", "stub", "stub", "stub"]);
    expect(decisions[2]).toEqual({ mode: "stub", reason: "limit" });
    expect(policy.choose("user", "ip-b")).toEqual({ mode: "live" });
    expect(policy.choose("user", "ip-c")).toEqual({ mode: "stub", reason: "limit" });
    expect(Object.isFrozen(decisions[0])).toBe(true);
  });

  it("uses a sliding hour rather than a clock-hour bucket and excludes the exact expired boundary", () => {
    const { policy, initial, setTime } = setup({ LIVE_LIMIT_PER_IP_PER_HOUR: 1, LIVE_LIMIT_PER_DAY: 10 });
    setTime(initial + 30 * 60_000);
    expect(policy.choose("user", "ip").mode).toBe("live");
    setTime(initial + 60 * 60_000);
    expect(policy.choose("user", "ip").reason).toBe("limit");
    setTime(initial + 90 * 60_000 - 1);
    expect(policy.choose("user", "ip").mode).toBe("stub");
    setTime(initial + 90 * 60_000);
    expect(policy.choose("user", "ip").mode).toBe("live");
  });

  it("resets the global cap at UTC midnight without resetting the rolling IP cap", () => {
    const start = Date.UTC(2026, 10, 26, 23, 59, 59);
    const { policy, setTime } = setup({ LIVE_LIMIT_PER_IP_PER_HOUR: 1, LIVE_LIMIT_PER_DAY: 1 }, start);
    expect(policy.choose("user", "ip-a").mode).toBe("live");
    expect(policy.choose("user", "ip-b").reason).toBe("limit");
    setTime(start + 1000);
    expect(policy.choose("user", "ip-a").reason).toBe("limit");
    expect(policy.choose("user", "ip-b").mode).toBe("live");
    expect(policy.choose("user", "ip-c").reason).toBe("limit");
  });

  it("never reserves counters for replay, including after the live cap is reached", () => {
    const { policy, clock } = setup({ LIVE_LIMIT_PER_IP_PER_HOUR: 1, LIVE_LIMIT_PER_DAY: 1 });
    for (let i = 0; i < 20; i++) expect(policy.choose("sim", "ip")).toEqual({ mode: "stub", reason: "replay" });
    expect(clock).not.toHaveBeenCalled();
    expect(policy.choose("user", "ip").mode).toBe("live");
    expect(policy.choose("user", "other").reason).toBe("limit");
    expect(policy.choose("sim", "ip")).toEqual({ mode: "stub", reason: "replay" });
  });

  it("never reads the clock or reserves counters with global stub inference", () => {
    const { policy, clock } = setup({ INFERENCE: "stub", OPENAI_API_KEY: undefined });
    for (let i = 0; i < 20; i++) expect(policy.choose("user", "ip")).toEqual({ mode: "stub" });
    expect(policy.choose("sim", "ip")).toEqual({ mode: "stub", reason: "replay" });
    expect(clock).not.toHaveBeenCalled();
  });

  it.each(["live", "stub"] as const)("preserves global %s mode for every source when demo is disabled", (INFERENCE) => {
    const { policy, clock } = setup({ PUBLIC_DEMO: false, INFERENCE });
    for (let i = 0; i < 20; i++) {
      expect(policy.choose("user", "ip")).toEqual({ mode: INFERENCE });
      expect(policy.choose("sim", "ip")).toEqual({ mode: INFERENCE });
    }
    expect(clock).not.toHaveBeenCalled();
  });
});
