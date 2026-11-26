import type { AgentName, Judgement, Verdict } from "@budget-crew/shared";

type Level = Verdict["level"];
type Decision = Judgement["decision"];

/**
 * Synthetic financial situations with the answer a careful human adviser would give.
 * Seed user (seed/synthetic-user.json): salary €2,500 on the 1st, €1,100 of planned
 * articles (rent €800 due on the 1st), so about €50 a day is free to spend.
 * Figures in `why` come from packages/budget, not from a model.
 */
export interface Scenario {
  id: string;
  kind: "expense" | "income" | "purchase";
  /** Ledger day of the request; the seed period opens on the 1st of `periodOf ?? today`'s month. */
  today: string;
  periodOf?: string;
  text: string;
  why: string;
  /** Judgement is debatable; reported separately and excluded from the strict score. */
  borderline?: true;
  /** Added after the prompts were tuned on the other scenarios: checks that fixes generalize. */
  holdout?: true;
  expect: {
    amount?: number;
    price?: number;
    incomeKind?: "salary" | "extra";
    category?: RegExp;
    item?: RegExp;
    /** The request may end with a parser error instead of a judgement. */
    mayFail?: true;
    levels?: Partial<Record<AgentName, Level[]>>;
    decision?: Decision[];
    /** At least one verdict/judgement text of the request must match. */
    mentions?: RegExp;
    /** No verdict/judgement text of the agent may match. */
    forbid?: { agent: AgentName | "Judge"; pattern: RegExp };
  };
}

export const scenarios: Scenario[] = [
  { id: "E1-coffee", kind: "expense", today: "2026-11-10", text: "coffee 3.50",
    why: "Routine €3.50 against a ~€50 daily allowance.",
    expect: { amount: 350, category: /food|coffee|drink|cafe/i, levels: { Pace: ["ok"], Anomaly: ["ok"] } } },
  { id: "E2-grocery-spike", kind: "expense", today: "2026-11-10", text: "groceries 420",
    why: "€420 is ~20x the €20 grocery average and 8x the daily allowance; next allowance drops by ~€18/day.",
    expect: { amount: 42000, category: /grocer/i, levels: { Pace: ["warn", "stop"], Anomaly: ["warn", "stop"] } } },
  { id: "E3-rent-double", kind: "expense", today: "2026-11-02", text: "paid rent 800",
    why: "Rent €800 is already a planned article reserved from salary; logging it as spending double-counts it.",
    expect: { amount: 80000, category: /rent|housing/i, levels: { Pace: ["warn", "stop"] },
      mentions: /planned|already|reserved|double|obligation/i } },
  { id: "E4-ru-taxi", kind: "expense", today: "2026-11-12", text: "такси 12,40",
    why: "Russian input, decimal comma: €12.40 transport, well inside the allowance.",
    expect: { amount: 1240, category: /transport|taxi/i, levels: { Pace: ["ok"] } } },
  { id: "E5-two-items", kind: "expense", today: "2026-11-12", text: "lunch 12.50 and coffee 3",
    why: "One message, two items: the expense is their sum, €15.50.",
    expect: { amount: 1550, category: /food|meal|dining|lunch/i, levels: { Pace: ["ok"] } } },
  { id: "E6-eu-thousands", kind: "expense", today: "2026-11-12", text: "laptop repair 1.234,56 €",
    why: "European thousands separator: €1,234.56 exceeds the ~€955 left, the period goes negative.",
    expect: { amount: 123456, levels: { Pace: ["stop"] } } },
  { id: "E7-late-dentist", kind: "expense", today: "2026-11-28", text: "dentist 300",
    why: "€300 with ~€150 left for three days: the period goes negative.",
    expect: { amount: 30000, category: /health|medical|dent/i, levels: { Pace: ["stop"] } } },
  { id: "I1-freelance", kind: "income", today: "2026-11-15", text: "freelance payment 450",
    why: "Extra income raises every remaining day's allowance.",
    expect: { amount: 45000, incomeKind: "extra", levels: { Pace: ["ok"], Coach: ["ok"] } } },
  { id: "I2-salary", kind: "income", today: "2026-12-01", periodOf: "2026-11-30", text: "salary 2600 arrived",
    why: "Payday salary opens a new period; all December articles fit into €2,600.",
    expect: { amount: 260000, incomeKind: "salary", levels: { Planner: ["ok"], Obligations: ["ok", "warn"] } } },
  { id: "I3-refund", kind: "income", today: "2026-11-20", text: "Mike paid me back 50 for dinner",
    why: "A refund is extra income, not salary.",
    expect: { amount: 5000, incomeKind: "extra", levels: { Pace: ["ok"] } } },
  { id: "P1-kindle-early", kind: "purchase", today: "2026-11-03", text: "Can I buy Kindle Paperwhite for 127.50?",
    why: "€127.50 is the 90-day low; allowance only moves €50.20 -> €45.48 with €1,355 left.",
    expect: { price: 12750, item: /kindle/i, levels: { Impact: ["ok"], "Deal Check": ["ok"] }, decision: ["buy"] } },
  { id: "P2-ps5-negative", kind: "purchase", today: "2026-11-26", text: "Can I buy PlayStation 5 for 425?",
    why: "€425 with €251 left: remaining goes to -€173.98.",
    expect: { price: 42500, item: /playstation|ps5/i, levels: { Impact: ["stop"] }, decision: ["skip", "wait"] } },
  { id: "P3-airpods-tight", kind: "purchase", today: "2026-11-26", text: "Can I buy AirPods for 187?",
    why: "Best 90-day price, but the next allowance falls €50.20 -> €16.00 for the last days.", borderline: true,
    expect: { price: 18700, item: /airpods/i, levels: { Impact: ["warn", "stop"] }, decision: ["wait", "skip"] } },
  { id: "P4-airpods-overpriced", kind: "purchase", today: "2026-11-10", text: "Can I buy AirPods for 220?",
    why: "Affordable, but the synthetic history shows €187.00 now; €220 is the old full price.",
    expect: { price: 22000, item: /airpods/i, levels: { "Deal Check": ["warn", "stop"] }, decision: ["wait", "skip"] } },
  { id: "P5-unknown-chair", kind: "purchase", today: "2026-11-10", text: "Can I buy an ergonomic chair for 180?",
    why: "Affordable (allowance €50.20 -> €43.72); no price history, so no discount claim.",
    expect: { price: 18000, item: /chair/i, levels: { Impact: ["ok", "warn"] }, decision: ["buy", "wait"],
      forbid: { agent: "Deal Check", pattern: /good deal|great deal|below (its )?usual|lowest price/i } } },
  { id: "P6-tv-black-friday", kind: "purchase", today: "2026-11-27", text: "Black Friday: Samsung TV for 595, should I buy?",
    why: "€595 with €200 left: remaining goes to -€394.18 despite a real discount.",
    expect: { price: 59500, item: /samsung|tv/i, levels: { Impact: ["stop"] }, decision: ["skip", "wait"] } },
  { id: "P7-ru-sony", kind: "purchase", today: "2026-11-14", text: "Можно купить Sony WH-1000XM5 за 297,50 €?",
    why: "Russian input, decimal comma; 90-day low; allowance €50.20 -> €34.75 with €853 left.",
    expect: { price: 29750, item: /sony|wh-1000xm5/i, levels: { "Deal Check": ["ok"] }, decision: ["buy", "wait"] } },
  { id: "P8-no-price", kind: "purchase", today: "2026-11-10", text: "Can I buy a coffee machine?",
    why: "No price given: the crew must not invent one or approve a purchase it cannot cost.",
    expect: { mayFail: true, decision: ["wait", "skip"] } },
  { id: "H1-bakery", kind: "expense", today: "2026-11-16", text: "bakery 2,80", holdout: true,
    why: "Decimal comma, small food expense.",
    expect: { amount: 280, category: /food|groceries|bakery/i, levels: { Pace: ["ok"] } } },
  { id: "H2-electricity-bill", kind: "expense", today: "2026-11-06", text: "electricity bill 150", holdout: true,
    why: "Utilities €150 due on the 5th is a planned article: double counting.",
    expect: { amount: 15000, category: /utilit|bill|electric|housing/i, mentions: /planned|already|reserved|double/i } },
  { id: "H3-two-coffees", kind: "expense", today: "2026-11-16", text: "2 coffees at 4.20 each", holdout: true,
    why: "Quantity times unit price: €8.40.",
    expect: { amount: 840, category: /food|coffee|drink/i, levels: { Pace: ["ok"] } } },
  { id: "H4-bonus", kind: "income", today: "2026-11-18", text: "year-end bonus 1200", holdout: true,
    why: "A bonus is extra income, not a new salary period.",
    expect: { amount: 120000, incomeKind: "extra", levels: { Pace: ["ok"] } } },
  { id: "H5-switch-low", kind: "purchase", today: "2026-11-18", text: "Can I buy Nintendo Switch for 255?", holdout: true,
    why: "90-day low; allowance €50.20 -> €33.14 (more than half kept) with €652 left.",
    expect: { price: 25500, item: /switch/i, levels: { "Deal Check": ["ok"] }, decision: ["buy"] } },
  { id: "H6-ipad-overpriced", kind: "purchase", today: "2026-11-08", text: "Can I buy iPad for 450?", holdout: true,
    why: "Affordable, but the synthetic history shows €382.50 now.",
    expect: { price: 45000, item: /ipad/i, levels: { "Deal Check": ["warn", "stop"] }, decision: ["wait", "skip"] } },
  { id: "H7-watch-squeeze", kind: "purchase", today: "2026-11-22", text: "Apple Watch for 340 — worth it now?", holdout: true,
    why: "90-day low, but the next allowance falls €50.20 -> €13.98 for eight days.",
    expect: { price: 34000, item: /apple watch|watch/i, levels: { Impact: ["warn", "stop"] }, decision: ["wait", "skip"] } },
  { id: "H8-dyson-no-price", kind: "purchase", today: "2026-11-12", text: "Should I get the Dyson V8 on Black Friday?", holdout: true,
    why: "No price stated: must not be costed or approved.",
    expect: { mayFail: true, decision: ["wait", "skip"] } },
];
