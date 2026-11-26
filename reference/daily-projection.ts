const hasOwn = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

export interface DailyProjectionOptions {
  dates?: readonly string[];
  plannedResidual?: number | string | null;
}

export interface DailyProjectionDay {
  date: string;
  expense: number | null;
  hasExpense: boolean;
  isClosedAtPlan: boolean;
  futureDays: number;
  allowance: number;
  nextAllowance: number | null;
  finalBalance: number | null;
  remaining: number;
}

/**
 * Redistribute daily allowance across a period based on actual spend.
 * Past days without a fact are treated as spent-at-plan when `today` is set.
 */
export function calculateDailyProjection(
  expenses: Record<string, unknown>,
  today: string | null = null,
  options: DailyProjectionOptions = {},
): DailyProjectionDay[] {
  const periodDates = options.dates || [];
  const plannedResidual = Number(options.plannedResidual || 0);
  const calendarDays = periodDates.length;
  if (!calendarDays) return [];

  const initialDailyAllowance = plannedResidual / calendarDays;
  let allowance = initialDailyAllowance;
  let totalSpent = 0;

  return periodDates.map((date, index) => {
    const futureDays = calendarDays - index - 1;
    const hasExpense = hasOwn(expenses, date);
    const expense = hasExpense ? Number(expenses[date]) : null;
    const allowanceForDate = allowance;
    const isClosedAtPlan = !hasExpense && today !== null && date < today;
    const effectiveExpense = expense ?? (isClosedAtPlan ? allowanceForDate : 0);

    totalSpent += effectiveExpense;
    if (expense !== null) {
      if (futureDays) allowance += (allowanceForDate - expense) / futureDays;
    }

    return {
      date,
      expense,
      hasExpense,
      isClosedAtPlan,
      futureDays,
      allowance: allowanceForDate,
      nextAllowance: futureDays ? allowance : null,
      finalBalance: futureDays ? null : plannedResidual - totalSpent,
      remaining: plannedResidual - totalSpent,
    };
  });
}
