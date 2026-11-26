export type ISODate = `${number}-${number}-${number}`;

export interface Income {
  id: string;
  requestId?: string;
  date: ISODate;
  amount: number;
  source: string;
  kind: 'salary' | 'extra';
}

export interface Expense {
  id: string;
  requestId?: string;
  date: ISODate;
  amount: number;
  category: string;
  note: string;
  source: 'user' | 'sim';
}

export interface PlannedArticle {
  id: string;
  name: string;
  amount: number;
  dueDate: ISODate;
  paid: boolean;
}

export interface Profile {
  name: string;
  currency: 'EUR';
  payday: number;
  recurringArticles: { name: string; amount: number; dueDay: number }[];
}

/** Money is in cents. remaining is the balance after this day's accounted spend. */
export interface DayProjection {
  date: ISODate;
  allowance: number;
  expense: number;
  remaining: number;
  nextAllowance?: number;
  finalBalance?: number;
}

export interface Period {
  id: string;
  status: 'open' | 'closed';
  start: ISODate;
  end: ISODate;
  salary: Income;
  carryover: number;
  extraIncomes: Income[];
  articles: PlannedArticle[];
  expenses: Expense[];
  projection: DayProjection[];
  finalBalance?: number;
}

const dayMs = 86_400_000;
const roundCents = (amount: number): number => Math.round(amount) + 0;
const timestamp = (date: ISODate): number => Date.parse(`${date}T00:00:00Z`);
const iso = (time: number): ISODate => new Date(time).toISOString().slice(0, 10) as ISODate;
const shift = (date: ISODate, days: number): ISODate => iso(timestamp(date) + days * dayMs);

function monthDay(year: number, month: number, day: number): ISODate {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return iso(Date.UTC(year, month, Math.min(day, last)));
}

function datesBetween(start: ISODate, end: ISODate): ISODate[] {
  const dates: ISODate[] = [];
  for (let time = timestamp(start); time <= timestamp(end); time += dayMs) dates.push(iso(time));
  return dates;
}

export interface ProjectionInput {
  dates: readonly ISODate[];
  residual: number;
  expensesByDate?: Readonly<Partial<Record<ISODate, number>>>;
  incomesByDate?: Readonly<Partial<Record<ISODate, number>>>;
  today?: ISODate;
}

/** Missing current/future spend is unknown, not zero-spend savings. Explicit zero redistributes. */
export function projectDaily({ dates, residual, expensesByDate = {}, incomesByDate = {}, today }: ProjectionInput): DayProjection[] {
  let remaining = residual;
  let allowance = residual / dates.length;
  return dates.map((date, index) => {
    const days = dates.length - index;
    const income = incomesByDate[date] ?? 0;
    allowance += income / days;
    remaining += income;
    const actual = expensesByDate[date];
    const assumed = actual === undefined && today !== undefined && date < today;
    // Assumed historical spending must also be a whole-cent ledger amount.
    const expense = actual ?? (assumed ? roundCents(allowance) : 0);
    remaining -= expense;
    const row: DayProjection = { date, allowance: roundCents(allowance), expense, remaining };
    if (days === 1) {
      row.finalBalance = remaining;
    } else {
      if (actual !== undefined || assumed) allowance += (allowance - expense) / (days - 1);
      row.nextAllowance = roundCents(allowance);
    }
    return row;
  });
}

function totalsByDate(entries: readonly { date: ISODate; amount: number }[]): Partial<Record<ISODate, number>> {
  const totals: Partial<Record<ISODate, number>> = {};
  for (const entry of entries) totals[entry.date] = (totals[entry.date] ?? 0) + entry.amount;
  return totals;
}

function projectionFor(period: Period, today?: ISODate, expenses = period.expenses): DayProjection[] {
  return projectDaily({
    dates: datesBetween(period.start, period.end),
    residual: period.salary.amount + period.carryover - period.articles.reduce((sum, article) => sum + article.amount, 0),
    expensesByDate: totalsByDate(expenses),
    incomesByDate: totalsByDate(period.extraIncomes),
    today,
  });
}

export function openPeriod(profile: Profile, salary: Income, carryover: number): Period {
  const date = new Date(timestamp(salary.date));
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  let nextPayday = monthDay(year, month, profile.payday);
  if (nextPayday <= salary.date) nextPayday = monthDay(year, month + 1, profile.payday);
  const end = shift(nextPayday, -1);
  const articles = profile.recurringArticles.map((article, index): PlannedArticle => {
    let dueDate = monthDay(year, month, article.dueDay);
    if (dueDate < salary.date) dueDate = monthDay(year, month + 1, article.dueDay);
    return { id: `${salary.id}:article:${index}`, name: article.name, amount: article.amount, dueDate, paid: false };
  }).filter(article => article.dueDate <= end);
  const period: Period = {
    id: salary.id, status: 'open', start: salary.date, end, salary: { ...salary }, carryover,
    extraIncomes: [], articles, expenses: [], projection: [],
  };
  period.projection = projectionFor(period);
  return period;
}

/** Preserve the original daily plan up to closure, including assumed historical spending. */
export function closePeriod(period: Period, closeDate: ISODate): { period: Period; finalBalance: number } {
  if (closeDate < period.start || closeDate > period.end) throw new RangeError('Close date must be inside the period');
  const closed: Period = {
    ...period, status: 'closed', end: closeDate,
    expenses: period.expenses.filter(expense => expense.date <= closeDate),
    extraIncomes: period.extraIncomes.filter(income => income.date <= closeDate),
  };
  closed.projection = projectionFor(period, shift(closeDate, 1)).filter(day => day.date <= closeDate);
  const last = closed.projection[closed.projection.length - 1]!;
  const finalBalance = last.remaining;
  delete last.nextAllowance;
  last.finalBalance = finalBalance;
  closed.finalBalance = finalBalance;
  return { period: closed, finalBalance };
}

export interface BudgetSimulation {
  todayAllowance: { before: number; after: number };
  nextAllowance: { before: number | undefined; after: number | undefined };
  deltaPerDay: number;
  remaining: { before: number; after: number };
  daysLeft: number;
  goesNegative: boolean;
}

export function simulateBudget(period: Period, today: ISODate, purchase: { amount: number; date?: ISODate }): BudgetSimulation {
  const purchaseDate = purchase.date ?? today;
  if (today < period.start || today > period.end || purchaseDate < today || purchaseDate > period.end) {
    throw new RangeError('Simulation dates must be in the remaining period');
  }
  const before = projectionFor(period, today);
  const after = projectionFor(period, today, [...period.expenses, {
    id: 'simulation', date: purchaseDate, amount: purchase.amount, category: '', note: '', source: 'sim',
  }]);
  const index = Math.round((timestamp(today) - timestamp(period.start)) / dayMs);
  const currentBefore = before[index]!;
  const currentAfter = after[index]!;
  const nextBefore = before[index + 1]?.allowance;
  const nextAfter = after[index + 1]?.allowance;
  return {
    todayAllowance: { before: currentBefore.allowance, after: currentAfter.allowance },
    nextAllowance: { before: nextBefore, after: nextAfter },
    deltaPerDay: nextBefore === undefined || nextAfter === undefined ? 0 : nextAfter - nextBefore,
    remaining: { before: currentBefore.remaining, after: currentAfter.remaining },
    daysLeft: before.length - index,
    goesNegative: after.slice(index).some(day => day.remaining < 0 || day.allowance < 0),
  };
}

/** Inclusive horizon: today through today + horizonDays. Planned amounts are already reserved. */
export function upcomingObligations(period: Period, today: ISODate, horizonDays: number): { unpaid: PlannedArticle[]; total: number } {
  const end = shift(today, horizonDays);
  const unpaid = period.articles.filter(article => !article.paid && article.dueDate >= today && article.dueDate <= end)
    .map(article => ({ ...article }));
  return { unpaid, total: unpaid.reduce((sum, article) => sum + article.amount, 0) };
}
