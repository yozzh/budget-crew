import { z } from "zod";
import {
  ExpenseRecordedPayload, IncomeRecordedPayload, PeriodClosedPayload, PeriodStartedPayload,
  PurchaseJudgedPayload, PurchaseParsedPayload, VerdictRecordedPayload, RequestFailedPayload,
  SimulationTickPayload, SimulationFinishedPayload, RequestCancelledPayload,
} from "./events.js";
import { RequestInference } from "./state.js";

const inference = { inference: RequestInference.optional() };

function envelope<T extends string, D extends z.ZodType>(type: T, data: D) {
  return z.strictObject({ v: z.literal(1), type: z.literal(type), at: z.iso.datetime(), data });
}

export const StateEnvelope = z.discriminatedUnion("type", [
  envelope("request.failed", RequestFailedPayload.extend(inference)),
  envelope("request.cancelled", RequestCancelledPayload.extend(inference)),
  envelope("period.started", PeriodStartedPayload.extend(inference)),
  envelope("period.closed", PeriodClosedPayload),
  envelope("income.recorded", IncomeRecordedPayload.extend({ remaining: z.int(), ...inference })),
  envelope("expense.recorded", ExpenseRecordedPayload.extend({ remaining: z.int(), ...inference })),
  envelope("purchase.parsed", PurchaseParsedPayload.extend(inference)),
  envelope("verdict.recorded", VerdictRecordedPayload.extend(inference)),
  envelope("purchase.judged", PurchaseJudgedPayload.extend(inference)),
  envelope("simulation.tick", SimulationTickPayload),
  envelope("simulation.finished", SimulationFinishedPayload),
  envelope("state.reset", z.strictObject({})),
]);
export type StateEnvelope = z.infer<typeof StateEnvelope>;
