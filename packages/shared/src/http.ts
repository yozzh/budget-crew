import { z } from "zod";

export const TextCommand = z.strictObject({ text: z.string().trim().min(1) });
export type TextCommand = z.infer<typeof TextCommand>;

export const AcceptedResponse = z.strictObject({ requestId: z.string().min(1) });
export type AcceptedResponse = z.infer<typeof AcceptedResponse>;

export const SimulationInput = z.strictObject({ speed: z.number().positive().default(4) });
export type SimulationInput = z.infer<typeof SimulationInput>;

export const SimulationRunningError = z.strictObject({ error: z.literal("simulation_running") });
export type SimulationRunningError = z.infer<typeof SimulationRunningError>;

export const NoOpenPeriodError = z.strictObject({ error: z.literal("no_open_period") });
export type NoOpenPeriodError = z.infer<typeof NoOpenPeriodError>;
