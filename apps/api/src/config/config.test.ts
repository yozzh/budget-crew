import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HealthController } from "../health.controller.js";
import { ConfigService, configSchema } from "./config.service.js";

const envKeys = [
  "INFERENCE", "OPENAI_API_KEY", "OPENAI_BASE_URL", "MOZAIK_API_KEY", "MOZAIK_PROJECT_ID",
  "CENTRIFUGO_API_URL", "CENTRIFUGO_API_KEY", "PORT", "HOST", "APP_VERSION",
  "PUBLIC_DEMO", "LIVE_LIMIT_PER_IP_PER_HOUR", "LIVE_LIMIT_PER_DAY",
] as const;

beforeEach(() => {
  for (const key of envKeys) vi.stubEnv(key, undefined);
});

afterEach(() => vi.unstubAllEnvs());

describe("ConfigService", () => {
  it("provides offline defaults without credentials", () => {
    expect(new ConfigService().env).toEqual({
      INFERENCE: "stub",
      PUBLIC_DEMO: false,
      LIVE_LIMIT_PER_IP_PER_HOUR: 10,
      LIVE_LIMIT_PER_DAY: 300,
      CENTRIFUGO_API_URL: "http://127.0.0.1:8000/api",
      PORT: 3000,
      HOST: "0.0.0.0",
      APP_VERSION: "dev",
    });
  });

  it("parses explicit settings and optional credentials", () => {
    const settings = {
      INFERENCE: "live", OPENAI_API_KEY: "openai-key", OPENAI_BASE_URL: "http://127.0.0.1:8318/v1",
      PUBLIC_DEMO: "true", LIVE_LIMIT_PER_IP_PER_HOUR: "2", LIVE_LIMIT_PER_DAY: "20",
      MOZAIK_API_KEY: "mozaik-key", MOZAIK_PROJECT_ID: "project-id",
      CENTRIFUGO_API_URL: "https://realtime.example/api",
      CENTRIFUGO_API_KEY: "centrifugo-key", PORT: "8080",
      HOST: "127.0.0.1", APP_VERSION: "1.2.3",
    };
    for (const [key, value] of Object.entries(settings)) vi.stubEnv(key, value);
    expect(new ConfigService().env).toEqual({
      ...settings, PORT: 8080, PUBLIC_DEMO: true, LIVE_LIMIT_PER_IP_PER_HOUR: 2, LIVE_LIMIT_PER_DAY: 20,
    });
  });

  it.each([
    { INFERENCE: "invalid" },
    { INFERENCE: "live" },
    { INFERENCE: "live", OPENAI_API_KEY: " " },
    { OPENAI_BASE_URL: "not-a-url" },
    { PORT: "0" },
    { PORT: "65536" },
    { PORT: "3000.5" },
    { PORT: "invalid" },
    { PORT: "" },
    { PUBLIC_DEMO: "yes" },
    { PUBLIC_DEMO: "1" },
    { PUBLIC_DEMO: "" },
    { LIVE_LIMIT_PER_IP_PER_HOUR: "0" },
    { LIVE_LIMIT_PER_IP_PER_HOUR: "-1" },
    { LIVE_LIMIT_PER_IP_PER_HOUR: "1.5" },
    { LIVE_LIMIT_PER_IP_PER_HOUR: "invalid" },
    { LIVE_LIMIT_PER_IP_PER_HOUR: "" },
    { LIVE_LIMIT_PER_DAY: "0" },
    { LIVE_LIMIT_PER_DAY: "-1" },
    { LIVE_LIMIT_PER_DAY: "1.5" },
    { LIVE_LIMIT_PER_DAY: "invalid" },
    { LIVE_LIMIT_PER_DAY: "" },
    { CENTRIFUGO_API_URL: "not-a-url" },
    { HOST: " " },
    { APP_VERSION: "" },
  ])("rejects invalid configuration: %j", (settings) => {
    expect(configSchema.safeParse(settings).success).toBe(false);
  });

  it.each(["1", "65535"])("accepts boundary port %s", (PORT) => {
    expect(configSchema.parse({ PORT }).PORT).toBe(Number(PORT));
  });

  it.each([false, "false", true, "true"])("parses explicit public demo setting %s", (PUBLIC_DEMO) => {
    expect(configSchema.parse({ PUBLIC_DEMO }).PUBLIC_DEMO).toBe(PUBLIC_DEMO === true || PUBLIC_DEMO === "true");
  });

  it("rejects invalid process environment at service creation", () => {
    vi.stubEnv("INFERENCE", "live");
    expect(() => new ConfigService()).toThrow(/OPENAI_API_KEY/);
  });
});

describe("health validated configuration", () => {
  it("reports offline defaults", () => {
    expect(new HealthController(new ConfigService()).get()).toEqual({
      status: "ok", version: "dev", inference: "stub",
    });
  });

  it("uses the validated snapshot instead of reading mutable process env", () => {
    vi.stubEnv("INFERENCE", "live");
    vi.stubEnv("OPENAI_API_KEY", "openai-key");
    vi.stubEnv("APP_VERSION", "release-517");
    const health = new HealthController(new ConfigService());
    vi.stubEnv("INFERENCE", "invalid");
    vi.stubEnv("APP_VERSION", "unvalidated");
    expect(health.get()).toEqual({
      status: "ok", version: "release-517", inference: "live",
    });
  });
});
