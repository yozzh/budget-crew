import type { RequestState, StateResponse } from "@budget-crew/shared";

export type RequestKind = RequestState["kind"];
export type Mode = "basic" | "pro";
export const endpoints: Record<RequestKind, string> = { expense: "/api/expenses", income: "/api/incomes", purchase: "/api/purchase-checks" };

/** A routing suggestion, not a parser: questions win over income words; the composer allows an override. */
export function classifyEntry(text: string): RequestKind {
  if (/\?|\b(can|could|should|would|may)\s+i\b|\b(afford|worth buying)\b/i.test(text)) return "purchase";
  if (/\b(salary|income|got|earned|received)\b/i.test(text)) return "income";
  return "expense";
}

/** Basic is the default; a valid URL mode wins over budget-crew-mode in localStorage. */
export function initialMode(search: string, stored: string | null): Mode {
  const mode = new URLSearchParams(search).get("mode");
  return mode === "basic" || mode === "pro" ? mode : stored === "pro" ? "pro" : "basic";
}

export function advisers(request: RequestState): string[] {
  if (request.kind === "purchase") return ["Impact", "Obligations", "Deal Check", "Alternatives"];
  if (request.kind === "expense") return ["Pace", "Anomaly", "Coach"];
  return request.parsed && "kind" in request.parsed && request.parsed.kind === "salary" ? ["Planner", "Obligations"] : ["Pace", "Coach"];
}

export function requestSummary(request: RequestState): string {
  if (request.error) return request.error;
  if (request.status === "cancelled") return "Replay stopped. Completed advice and recorded money are kept.";
  if (request.judgement) return request.judgement.why;
  return ["Pace", ...Object.keys(request.verdicts).filter((agent) => agent !== "Pace")]
    .flatMap((agent) => {
      const slot = request.verdicts[agent as keyof typeof request.verdicts];
      return slot && !("status" in slot) ? [slot.headline.replace(/[.!?]+$/, "")] : [];
    }).join(". ");
}

/** Closed-month totals in integer cents. Savings use the ledger's final balance, including carryover. */
export function deriveHistory(snapshot: StateResponse) {
  return snapshot.periods.filter((period) => period.status === "closed").sort((a, b) => a.start.localeCompare(b.start)).map((period) => {
    // Projection accounts for assumed past spend as well as recorded expenses.
    const spent = period.articles.reduce((sum, article) => sum + article.amount, 0)
      + period.projection.reduce((sum, day) => sum + day.expense, 0);
    const balance = period.finalBalance ?? period.salary.amount + period.carryover
      + period.extraIncomes.reduce((sum, income) => sum + income.amount, 0) - spent;
    const requests = Object.entries(snapshot.requests).filter(([, request]) => {
      const date = request.date ?? request.createdAt.slice(0, 10);
      return date >= period.start && date <= period.end;
    }).sort(([, a], [, b]) => a.createdAt.localeCompare(b.createdAt));
    const notable = requests.find(([, request]) => request.judgement) ?? requests.find(([, request]) => {
      const coach = request.verdicts.Coach;
      return coach && !("status" in coach);
    });
    return { period, spent, balance, requests, moment: notable ? requestSummary(notable[1]) : "A month of everyday money decisions." };
  });
}
