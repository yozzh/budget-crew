import { z } from "zod";
import { AgentName } from "./agents.js";

export const ActivityEnvelope = z.strictObject({
  v: z.literal(1),
  type: z.literal("agent.activity"),
  at: z.iso.datetime(),
  data: z.strictObject({
    agent: AgentName,
    loopId: z.string(),
    requestId: z.string().optional(),
    phase: z.enum(["received", "thinking", "tool", "answered", "failed"]),
    tool: z.string().optional(),
    summary: z.string().max(120).optional(),
  }),
});
export type ActivityEnvelope = z.infer<typeof ActivityEnvelope>;
