import { z } from "zod";
import {
  ExpenseRecordedPayload, IncomeRecordedPayload, PeriodClosedPayload, PeriodStartedPayload,
  PurchaseJudgedPayload, PurchaseParsedPayload, VerdictRecordedPayload, RequestFailedPayload,
  SimulationTickPayload, SimulationFinishedPayload,
} from "./events.js";

function envelope<T extends string, D extends z.ZodType>(type: T, data: D) {
  return z.strictObject({ v: z.literal(1), type: z.literal(type), at: z.iso.datetime(), data });
}

export const StateEnvelope = z.discriminatedUnion("type", [
  envelope("request.failed", RequestFailedPayload),
  envelope("period.started", PeriodStartedPayload),
  envelope("period.closed", PeriodClosedPayload),
  envelope("income.recorded", IncomeRecordedPayload.extend({ remaining: z.int() })),
  envelope("expense.recorded", ExpenseRecordedPayload.extend({ remaining: z.int() })),
  envelope("purchase.parsed", PurchaseParsedPayload),
  envelope("verdict.recorded", VerdictRecordedPayload),
  envelope("purchase.judged", PurchaseJudgedPayload),
  envelope("simulation.tick", SimulationTickPayload),
  envelope("simulation.finished", SimulationFinishedPayload),
  envelope("state.reset", z.strictObject({})),
]);
export type StateEnvelope = z.infer<typeof StateEnvelope>;
