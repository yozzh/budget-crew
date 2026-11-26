import { describe, expect, it } from "vitest";
import { SemanticEvent } from "@mozaik-ai/core";
import type { ActivityEnvelope } from "@budget-crew/shared";
import { createObserver, type ActivityPublisher } from "./observer.js";

function harness(publish?: ActivityPublisher["publish"]) {
  const publications: ActivityEnvelope[] = [];
  const observer = createObserver({ publish: publish ?? ((channel, envelope) => {
    expect(channel).toBe("crew:activity");
    publications.push(envelope);
  }) }, (id) => id === "participant-1" ? "Analyst" : undefined);
  const handler = observer.getHandlers()[0]!;
  function send(type: string, payload: unknown, producerId = "participant-1") {
    const context = {
      participant: observer,
      event: new SemanticEvent(type, producerId, new Date("2026-01-01T00:00:00.000Z"), payload),
    };
    expect(handler.specification.isSatisfiedBy(context)).toBe(true);
    return handler.processor.apply(context);
  }
  return { publications, send };
}

describe("activity observer", () => {
  it("maps core events synchronously without exposing prompts or answers", () => {
    const { publications, send } = harness();
    send("message_received.started", { loopId: "loop", content: "[req:request-1] private prompt", input: { secret: "private input" } });
    send("inference.started", { loopId: "loop", prompt: "private prompt" });
    send("function_call.started", { loopId: "loop", call: { name: "budget", arguments: "private arguments" }, inferenceInput: "private input" });
    send("model.answer", { loopId: "loop", answer: "private answer" });
    expect(publications.map(({ data }) => data.phase)).toEqual(["received", "thinking", "tool", "answered"]);
    expect(publications.every(({ data }) => data.agent === "Analyst" && data.requestId === "request-1")).toBe(true);
    expect(publications[2]?.data.tool).toBe("budget");
    expect(JSON.stringify(publications)).not.toContain("private");
    send("inference.started", { loopId: "loop" });
    expect(publications.at(-1)?.data.requestId).toBeUndefined();
  });

  it("requires an anchored request prefix and isolates producer and loop identities", () => {
    const { publications, send } = harness();
    send("message_received.started", { loopId: "a", content: "[req:one] secret" });
    send("message_received.started", { loopId: "b", content: "prefix [req:two] secret" });
    send("inference.started", { loopId: "a" }, "participant-2");
    expect(publications[1]?.data.requestId).toBeUndefined();
    expect(publications[2]?.data).toMatchObject({ agent: "participant-2", loopId: "a" });
    expect(publications[2]?.data.requestId).toBeUndefined();
    send("inference.started", { loopId: "a" });
    expect(publications.at(-1)?.data.requestId).toBe("one");
    send("model.answer", { loopId: "a" });
    send("message_received.started", { loopId: "a", content: "no prefix" });
    expect(publications.at(-1)?.data.requestId).toBeUndefined();
  });

  it("accepts unrelated events without publication", () => {
    const { publications, send } = harness();
    send("unrelated", {});
    send("inference.started", null);
    send("inference.started", { loopId: 1 });
    expect(publications).toEqual([]);
  });

  it("contains synchronous and asynchronous publisher failures", async () => {
    const sync = harness(() => { throw new Error("offline"); });
    expect(() => sync.send("inference.started", { loopId: "a" })).not.toThrow();
    const async = harness(() => Promise.reject(new Error("offline")));
    await async.send("inference.started", { loopId: "a" });
    await Promise.resolve();
  });
});
