import { z } from "zod";
import { AgentName, Judgement, ParsedExpense, ParsedIncome, ParsedPurchase, VerdictSlot } from "./agents.js";
import { ISODate, Period, Profile } from "./domain.js";

export const Verdicts = z.partialRecord(AgentName, VerdictSlot);
export type Verdicts = z.infer<typeof Verdicts>;

export const RequestState = z.strictObject({
  kind: z.enum(["expense", "purchase", "income"]),
  input: z.string(),
  source: z.enum(["user", "sim"]).optional(),
  date: ISODate.optional(),
  parsed: z.union([ParsedExpense, ParsedPurchase, ParsedIncome]).optional(),
  error: z.string().optional(),
  verdicts: Verdicts,
  judgement: Judgement.optional(),
  createdAt: z.iso.datetime(),
});
export type RequestState = z.infer<typeof RequestState>;

export const BudgetStateSnapshot = z.strictObject({
  profile: Profile,
  periods: z.array(Period),
  currentPeriodId: z.string().optional(),
  today: ISODate,
  requests: z.record(z.string(), RequestState),
  simulation: z.strictObject({
    running: z.boolean(),
    day: ISODate.optional(),
    speed: z.number().positive(),
  }),
});
export type BudgetStateSnapshot = z.infer<typeof BudgetStateSnapshot>;

export const StateSchema = BudgetStateSnapshot;
export const StateResponse = BudgetStateSnapshot;
export type StateResponse = z.infer<typeof StateResponse>;
