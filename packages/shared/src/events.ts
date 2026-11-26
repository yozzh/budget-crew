import { z } from "zod";
import { AgentName, Judgement, ParsedPurchase, VerdictSlot } from "./agents.js";
import { BudgetSimulation, DayProjection, Expense, ISODate, Income, Period } from "./domain.js";
import { Verdicts } from "./state.js";

const RequestId = z.string().min(1);
export const RequestFailedPayload = z.strictObject({ requestId: RequestId, error: z.string() });
export const ExpenseSubmittedPayload = z.strictObject({ requestId: RequestId, text: z.string(), date: ISODate });
export const PurchaseSubmittedPayload = z.strictObject({ requestId: RequestId, text: z.string() });
export const IncomeSubmittedPayload = z.strictObject({ requestId: RequestId, text: z.string(), date: ISODate });
export const ExpenseRecordedPayload = z.strictObject({ requestId: RequestId, expense: Expense, projectionToday: DayProjection });
export const IncomeRecordedPayload = z.strictObject({ requestId: RequestId, income: Income, projectionToday: DayProjection });
export const PeriodClosedPayload = z.strictObject({ periodId: z.string(), finalBalance: z.int() });
export const PeriodStartedPayload = z.strictObject({ requestId: RequestId, period: Period });
export const PurchaseParsedPayload = z.strictObject({ requestId: RequestId, purchase: ParsedPurchase });
export const VerdictRecordedPayload = z.strictObject({ requestId: RequestId, agent: AgentName, verdict: VerdictSlot });
export const PurchaseReadyPayload = z.strictObject({ requestId: RequestId, verdicts: Verdicts, simulation: BudgetSimulation });
export const PurchaseJudgedPayload = z.strictObject({ requestId: RequestId, judgement: Judgement });
export const DayAdvancedPayload = z.strictObject({ day: ISODate });
export const SimulationPayload = DayAdvancedPayload;

// Runtime-owned payload fields evolve independently; Observer still requires loop linkage.
export const RuntimeLoopPayload = z.looseObject({ loopId: z.string() });
export const ModelAnswerPayload = RuntimeLoopPayload.extend({ answer: z.unknown() });

export const RuntimeEventPayloads = {
  "request.failed": RequestFailedPayload,
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
  "simulation.*": SimulationPayload,
  "message_received.*": RuntimeLoopPayload,
  "inference.*": RuntimeLoopPayload,
  "function_call.*": RuntimeLoopPayload,
};

export type RuntimeEventPayloads = {
  [T in keyof typeof RuntimeEventPayloads]: z.infer<(typeof RuntimeEventPayloads)[T]>;
};
