import { z } from "zod";

export const TextCommand = z.strictObject({ text: z.string().trim().min(1) });
export type TextCommand = z.infer<typeof TextCommand>;

export const AcceptedResponse = z.strictObject({ requestId: z.string().min(1) });
export type AcceptedResponse = z.infer<typeof AcceptedResponse>;

export const SimulationInput = z.strictObject({ speed: z.number().positive() });
export type SimulationInput = z.infer<typeof SimulationInput>;

export const NoOpenPeriodError = z.strictObject({ error: z.literal("no_open_period") });
export type NoOpenPeriodError = z.infer<typeof NoOpenPeriodError>;
