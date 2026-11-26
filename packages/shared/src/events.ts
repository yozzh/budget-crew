import { z } from "zod";
import { AgentName, Judgement, ParsedPurchase, VerdictSlot } from "./agents.js";
import { BudgetSimulation, DayProjection, Expense, ISODate, Income, Period } from "./domain.js";
import { RequestState, Verdicts } from "./state.js";

const RequestId = z.string().min(1);
export const RequestFailedPayload = z.strictObject({ requestId: RequestId, error: z.string() });
export const RequestCancelledPayload = z.strictObject({ requestId: RequestId, request: RequestState });
const Submission = z.strictObject({
  requestId: RequestId, text: z.string(),
  source: z.enum(["user", "sim"]).optional(), runId: z.string().min(1).optional(),
});
export const ExpenseSubmittedPayload = Submission.extend({ date: ISODate });
export const PurchaseSubmittedPayload = Submission.extend({ date: ISODate.optional() });
export const IncomeSubmittedPayload = Submission.extend({ date: ISODate });
export const ExpenseRecordedPayload = z.strictObject({ requestId: RequestId, expense: Expense, projectionToday: DayProjection });
export const IncomeRecordedPayload = z.strictObject({ requestId: RequestId, income: Income, projectionToday: DayProjection });
export const PeriodClosedPayload = z.strictObject({ periodId: z.string(), finalBalance: z.int() });
export const PeriodStartedPayload = z.strictObject({ requestId: RequestId, period: Period });
export const PurchaseParsedPayload = z.strictObject({ requestId: RequestId, purchase: ParsedPurchase });
export const VerdictRecordedPayload = z.strictObject({ requestId: RequestId, agent: AgentName, verdict: VerdictSlot });
export const PurchaseReadyPayload = z.strictObject({ requestId: RequestId, verdicts: Verdicts, simulation: BudgetSimulation });
export const PurchaseJudgedPayload = z.strictObject({ requestId: RequestId, judgement: Judgement });
export const DayAdvancedPayload = z.strictObject({ day: ISODate, runId: z.string().min(1).optional() });
export const SimulationTickPayload = z.strictObject({ day: ISODate, running: z.boolean(), speed: z.number().positive() });
export const SimulationFinishedPayload = SimulationTickPayload.extend({ running: z.literal(false) });
export const SimulationMonth = z.strictObject({
  days: z.array(z.strictObject({
    date: ISODate, incomes: z.array(z.string().min(1)), expenses: z.array(z.string().min(1)), purchases: z.array(z.string().min(1)),
  })).min(1),
});
export type SimulationMonth = z.infer<typeof SimulationMonth>;

// Runtime-owned payload fields evolve independently; Observer still requires loop linkage.
export const RuntimeLoopPayload = z.looseObject({ loopId: z.string() });
export const ModelAnswerPayload = RuntimeLoopPayload.extend({ answer: z.unknown() });

export const RuntimeEventPayloads = {
  "request.failed": RequestFailedPayload,
  "request.cancelled": RequestCancelledPayload,
  "expense.submitted": ExpenseSubmittedPayload,
  "purchase.submitted": PurchaseSubmittedPayload,
  "income.submitted": IncomeSubmittedPayload,
  "model.answer": ModelAnswerPayload,
  "expense.recorded": ExpenseRecordedPayload,
  "income.recorded": IncomeRecordedPayload,
  "period.closed": PeriodClosedPayload,
  "period.started": PeriodStartedPayload,
  "purchase.parsed": PurchaseParsedPayload,
  "verdict.recorded": VerdictRecordedPayload,
  "purchase.ready": PurchaseReadyPayload,
  "purchase.judged": PurchaseJudgedPayload,
  "day.advanced": DayAdvancedPayload,
  "simulation.tick": SimulationTickPayload,
  "simulation.finished": SimulationFinishedPayload,
  "message_received.*": RuntimeLoopPayload,
  "inference.*": RuntimeLoopPayload,
  "function_call.*": RuntimeLoopPayload,
};

export type RuntimeEventPayloads = {
  [T in keyof typeof RuntimeEventPayloads]: z.infer<(typeof RuntimeEventPayloads)[T]>;
};
