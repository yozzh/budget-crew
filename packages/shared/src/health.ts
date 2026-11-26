import { z } from "zod";

export const HealthResponse = z.object({
  status: z.literal("ok"),
  version: z.string(),
  inference: z.enum(["live", "stub"]),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
