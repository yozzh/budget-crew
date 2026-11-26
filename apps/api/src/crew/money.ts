const euros = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2,
});

export function formatEuros(amount: number): string {
  return euros.format(amount / 100);
}

// Monetary keys in ledger events, budget projections, simulations and tool results.
// before/after are monetary simulation pairs; counts and days stay numeric.
const moneyKeys: Record<string, true | undefined> = {
  amount: true, price: true, allowance: true, expense: true, remaining: true,
  nextAllowance: true, finalBalance: true, carryover: true, total: true,
  average: true, todayAllowance: true, deltaPerDay: true, before: true, after: true,
  remainingAfterObligations: true, remainingAfterPurchaseAndObligations: true, weekAllowance: true,
};

/** Copy code-owned data into a display-only LLM payload. Never mutate the ledger. */
export function formatMoneyFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(formatMoneyFields);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    typeof child === "number" && moneyKeys[key] === true ? formatEuros(child) : formatMoneyFields(child),
  ]));
}
