import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { ActivityEnvelope } from "@budget-crew/shared";
import type { ConfigService } from "../config/config.service.js";
import { CentrifugoPublisher } from "./centrifugo.publisher.js";

const envelope: ActivityEnvelope = {
  v: 1,
  type: "agent.activity",
  at: "2026-01-01T00:00:00.000Z",
  data: { agent: "Analyst", loopId: "a", phase: "thinking" },
};
function publisher() {
  return new CentrifugoPublisher({ env: {
    CENTRIFUGO_API_URL: "http://centrifugo.invalid/api/",
    CENTRIFUGO_API_KEY: "test-key",
  } } as ConfigService);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CentrifugoPublisher", () => {
  it("posts the envelope using the Centrifugo HTTP API", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: {} }) });
    vi.stubGlobal("fetch", fetch);
    await publisher().publish("crew:activity", envelope);
    expect(fetch).toHaveBeenCalledWith("http://centrifugo.invalid/api/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "test-key" },
      body: JSON.stringify({ channel: "crew:activity", data: envelope }),
    });
  });

  it.each(["transport", "http", "api", "invalid-json"])("logs and swallows %s failures", async (failure) => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    const fetch = vi.fn();
    if (failure === "transport") fetch.mockRejectedValue(new Error("private network detail"));
    else fetch.mockResolvedValue({
      ok: failure !== "http",
      status: 503,
      json: async () => {
        if (failure === "invalid-json") throw new SyntaxError("private response");
        return { error: { code: 100, message: "private API detail" } };
      },
    });
    vi.stubGlobal("fetch", fetch);
    await expect(publisher().publish("crew:activity", envelope)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
  });
});
