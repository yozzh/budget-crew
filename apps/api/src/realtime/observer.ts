import { createHuman, SituationSpecification } from "@mozaik-ai/core";
import type { ActivityEnvelope } from "@budget-crew/shared";

export interface ActivityPublisher {
  publish(channel: string, envelope: ActivityEnvelope): void | Promise<void>;
}

class EveryEvent extends SituationSpecification {
  isSatisfiedBy(): boolean {
    return true;
  }
}

const phases: Readonly<Record<string, ActivityEnvelope["data"]["phase"]>> = {
  "message_received.started": "received",
  "inference.started": "thinking",
  "function_call.started": "tool",
  "model.answer": "answered",
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

export function createObserver(
  publisher: ActivityPublisher,
  resolveAgentName: (producerId: string) => string | undefined = (id) => id,
) {
  const requests = new Map<string, Map<string, string>>();
  return createHuman({
    name: "Observer",
    capabilities: [],
    handlers: [{
      specification: new EveryEvent(),
      processor: {
        apply({ event }) {
          const phase = Object.hasOwn(phases, event.type) ? phases[event.type] : undefined;
          const payload = record(event.payload);
          if (!phase || !payload || typeof payload.loopId !== "string") return;
          const loopId = payload.loopId;
          let producerRequests = requests.get(event.producerId);
          if (phase === "received") {
            const requestId = typeof payload.content === "string"
              ? /^\[req:([^\]\r\n]+)\]/.exec(payload.content)?.[1]
              : undefined;
            if (requestId) {
              if (!producerRequests) {
                producerRequests = new Map();
                requests.set(event.producerId, producerRequests);
              }
              producerRequests.set(loopId, requestId);
            } else {
              producerRequests?.delete(loopId);
              if (producerRequests?.size === 0) requests.delete(event.producerId);
            }
          }
          const requestId = producerRequests?.get(loopId);
          const call = record(payload.call);
          const tool = phase === "tool" && typeof call?.name === "string"
            ? call.name : undefined;
          if (phase === "answered") {
            producerRequests?.delete(loopId);
            if (producerRequests?.size === 0) requests.delete(event.producerId);
          }
          const envelope: ActivityEnvelope = {
            v: 1,
            type: "agent.activity",
            at: event.occurredAt.toISOString(),
            data: {
              agent: resolveAgentName(event.producerId) ?? event.producerId,
              loopId,
              phase,
              ...(requestId === undefined ? {} : { requestId }),
              ...(tool === undefined ? {} : { tool }),
            },
          };
          // Call immediately so recording publishers observe runtime event order.
          try {
            const publication = publisher.publish("crew:activity", envelope);
            if (publication) void publication.catch(() => {});
          } catch {
            // Realtime delivery must never interrupt an agent loop.
          }
        },
      },
    }],
  });
}
