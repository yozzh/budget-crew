import type { Period } from "@budget-crew/shared";

/** Original salary plan stays fixed; actual allowances come only from the API. */
export function allowanceChartData(period: Period | undefined) {
  if (!period || period.status !== "open") return [];
  const days = Math.round((Date.parse(`${period.end}T00:00:00Z`) - Date.parse(`${period.start}T00:00:00Z`)) / 86_400_000) + 1;
  const residual = period.salary.amount + period.carryover - period.articles.reduce((sum, article) => sum + article.amount, 0);
  const planned = Math.round(residual / days) / 100;
  return period.projection.map((day) => ({ date: day.date, planned, actual: day.allowance / 100 }));
}
