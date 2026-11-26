import { z } from "zod";

export const AgentName = z.enum([
  "Parser", "Planner", "Pace", "Anomaly", "Coach", "Impact", "Obligations",
  "Deal Check", "Alternatives", "Judge",
]);
export type AgentName = z.infer<typeof AgentName>;

export const ParsedExpense = z.strictObject({
  amount: z.int().nonnegative(),
  category: z.string(),
  note: z.string(),
});
export type ParsedExpense = z.infer<typeof ParsedExpense>;

export const ParsedPurchase = z.strictObject({
  item: z.string(),
  price: z.int().nonnegative(),
  category: z.string(),
});
export type ParsedPurchase = z.infer<typeof ParsedPurchase>;

export const ParsedIncome = z.strictObject({
  amount: z.int().nonnegative(),
  kind: z.enum(["salary", "extra"]),
  source: z.string(),
});
export type ParsedIncome = z.infer<typeof ParsedIncome>;

const Figure = z.strictObject({ label: z.string(), value: z.string() });
export const Verdict = z.strictObject({
  level: z.enum(["ok", "warn", "stop"]),
  headline: z.string().max(80),
  reason: z.string().max(280),
  figures: z.array(Figure),
});
export type Verdict = z.infer<typeof Verdict>;

export const Judgement = z.strictObject({
  decision: z.enum(["buy", "wait", "skip"]),
  why: z.string(),
  figures: z.array(Figure),
});
export type Judgement = z.infer<typeof Judgement>;

export const VerdictSlot = z.union([
  Verdict,
  z.strictObject({ status: z.literal("failed"), error: z.string() }),
  z.strictObject({ status: z.literal("cancelled"), reason: z.literal("simulation_stopped") }),
]);
export type VerdictSlot = z.infer<typeof VerdictSlot>;

export const agentOutputJsonSchemas = {
  ParsedExpense: z.toJSONSchema(ParsedExpense),
  ParsedPurchase: z.toJSONSchema(ParsedPurchase),
  ParsedIncome: z.toJSONSchema(ParsedIncome),
  Verdict: z.toJSONSchema(Verdict),
  Judgement: z.toJSONSchema(Judgement),
};
