import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePeriod, openPeriod, projectDaily, simulateBudget, upcomingObligations } from '../packages/budget/src/index.ts';
import type { ISODate, Period, Profile } from '../packages/budget/src/index.ts';
import type { RequestState, Verdict } from '../packages/shared/src/index.js';

const profile: Profile = {
  name: 'Alex', currency: 'EUR', payday: 1,
  recurringArticles: [
    { name: 'Rent', amount: 80000, dueDay: 1 },
    { name: 'Utilities', amount: 15000, dueDay: 5 },
    { name: 'Phone', amount: 2500, dueDay: 10 },
    { name: 'Transport pass', amount: 6500, dueDay: 1 },
    { name: 'Music subscription', amount: 1000, dueDay: 12 },
    { name: 'Video subscription', amount: 5000, dueDay: 15 },
  ],
};

const money = (amount: number): string => `${amount < 0 ? '-' : ''}€${(Math.abs(amount) / 100).toFixed(2)}`;
const figure = (label: string, amount: number) => ({ label, value: money(amount) });
const verdict = (headline: string, reason: string, figures: Verdict['figures'], level: Verdict['level'] = 'ok'): Verdict => ({ level, headline, reason, figures });
const dateOf = (month: number, day: number): ISODate => `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` as ISODate;

function refresh(period: Period, today: ISODate): void {
  const expensesByDate: Partial<Record<ISODate, number>> = {};
  const incomesByDate: Partial<Record<ISODate, number>> = {};
  for (const expense of period.expenses) expensesByDate[expense.date] = (expensesByDate[expense.date] ?? 0) + expense.amount;
  for (const income of period.extraIncomes) incomesByDate[income.date] = (incomesByDate[income.date] ?? 0) + income.amount;
  period.projection = projectDaily({
    dates: period.projection.map(row => row.date),
    residual: period.salary.amount + period.carryover - period.articles.reduce((sum, article) => sum + article.amount, 0),
    expensesByDate, incomesByDate, today,
  });
}

const purchasePlans = [
  { month: 6, day: 12, item: 'commuter bike', price: 34000, decision: 'wait', why: 'Keep using the transport pass already reserved this month; save separately for the bike.' },
  { month: 6, day: 23, item: 'designer trainers', price: 21000, decision: 'skip', why: 'The current shoes still work; leave this optional upgrade out of the plan.' },
  { month: 7, day: 18, item: 'desk lamp', price: 3900, decision: 'buy', why: 'The side gig has arrived and this modest work purchase fits the remaining budget.' },
  { month: 7, day: 25, item: 'espresso machine', price: 29900, decision: 'wait', why: 'Set money aside first rather than committing the remaining daily budget.' },
  { month: 8, day: 22, item: 'tablet', price: 45900, decision: 'skip', why: 'Holiday spending has priority; another device would deepen the shortfall.' },
  { month: 9, day: 14, item: 'new phone', price: 69900, decision: 'skip', why: 'The existing phone has just been repaired; do not pay for a replacement as well.' },
  { month: 9, day: 24, item: 'weekend trip', price: 24000, decision: 'wait', why: 'Recover from the holiday carryover and repair before booking another trip.' },
  { month: 10, day: 24, item: 'headphones', price: 7900, decision: 'buy', why: 'This planned replacement fits after a quieter month; keep the remaining daily spending modest.' },
] as const;

/** Five synthetic closed months; every opinion sees only the ledger available at its timestamp. */
export function generateHistory(): { periods: Period[]; requests: Record<string, RequestState> } {
  let seed = 5352026;
  const random = (min: number, max: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return min + Math.floor((seed / 0x100000000) * (max - min + 1));
  };
  const periods: Period[] = [];
  const requests: Record<string, RequestState> = {};
  let previousBalance = 0;
  for (let month = 6; month <= 10; month++) {
    const date = dateOf(month, 1);
    const salaryId = `history-${date}-salary`;
    const period = openPeriod(profile, { id: salaryId, requestId: salaryId, date, amount: 250000, source: 'Synthetic employer', kind: 'salary' }, Math.min(0, previousBalance));
    const reserved = period.articles.reduce((sum, article) => sum + article.amount, 0);
    const savings = previousBalance > 0 ? ` I moved last month's ${money(previousBalance)} surplus to savings, outside this spending budget.` : '';
    requests[salaryId] = {
      kind: 'income', source: 'user', date, createdAt: `${date}T08:00:00.000Z`,
      input: `My salary of €2500.00 from Synthetic employer arrived.${savings}`,
      parsed: { amount: 250000, kind: 'salary', source: 'Synthetic employer' },
      verdicts: {
        Planner: verdict('The monthly plan is ready', `After ${money(reserved)} in recurring bills and ${money(period.carryover)} carryover, the opening daily allowance is ${money(period.projection[0]!.allowance)}.${previousBalance > 0 ? ' Last month’s surplus is in separate savings.' : ''}`, [figure('Salary', 250000), figure('Carryover', period.carryover), figure('Opening daily allowance', period.projection[0]!.allowance)]),
        Obligations: verdict('Recurring bills are reserved', 'Rent, utilities, phone, transport, music and video are already deducted from the spending budget; do not record them again as daily expenses.', [figure('Reserved recurring bills', reserved)]),
      },
    };
    const days = period.projection.length;
    for (let day = 1; day <= days; day++) {
      const today = dateOf(month, day);
      if (month === 7 && day === 15) {
        const id = `history-${today}-side-gig`;
        period.extraIncomes.push({ id, requestId: id, date: today, amount: 22000, kind: 'extra', source: 'Weekend design side gig' });
        refresh(period, today);
        const row = period.projection[day - 1]!;
        requests[id] = {
          kind: 'income', date: today, source: 'user', createdAt: `${today}T08:30:00.000Z`, input: 'I received €220.00 for a weekend design side gig.',
          parsed: { amount: 22000, kind: 'extra', source: 'Weekend design side gig' },
          verdicts: {
            Pace: verdict('The side gig gives some breathing room', `The extra ${money(22000)} is now in the ledger. Today's allowance is ${money(row.allowance)} before today's expenses.`, [figure('Extra income', 22000), figure('Daily allowance', row.allowance)]),
            Coach: verdict('Keep the extra income deliberate', `There is ${money(row.remaining)} left after bills and spending so far. Keep the usual routine instead of treating the whole payment as shopping money.`, [figure('Remaining spending balance', row.remaining)]),
          },
        };
      }
      const daily = [
        { category: 'food', note: 'Morning coffee', amount: random(250, 400) },
        { category: 'groceries', note: 'Fresh groceries', amount: random(400, 750) },
        { category: 'food', note: 'Lunch', amount: random(550, 850) },
      ];
      const extras = [
        { category: 'transport', note: 'Bus outside the pass zone', amount: random(180, 400) },
        { category: 'dining', note: 'Dinner with friends', amount: random(900, 1800) },
        { category: 'pharmacy', note: 'Pharmacy essentials', amount: random(350, 850) },
        { category: 'entertainment', note: 'Cinema or local event', amount: random(600, 1200) },
      ];
      const count = random(0, 3);
      for (let index = 0; index < count; index++) daily.push(extras[(day + index + month) % extras.length]!);
      if (month === 8 && day === 10) daily.splice(2, 1, { category: 'travel', note: 'Summer holiday accommodation and train tickets', amount: 130000 });
      if (month === 9 && day === 8) daily.splice(2, 1, { category: 'repairs', note: 'Phone screen repair', amount: 18000 });
      for (const [index, entry] of daily.entries()) {
        // October is deliberately quieter after the holiday and repair months.
        if (month === 10) entry.amount = Math.round(entry.amount * 0.8);
        const isFeatured = (day === 5 && index === 0) || (day === 10 && index === 2) || (day === 20 && index === 1) || (month === 9 && day === 8 && index === 2);
        // September's repair replaces the usual day-ten featured request.
        const linked = isFeatured && !(month === 9 && day === 10 && index === 2);
        const id = `history-${today}-expense-${index + 1}`;
        period.expenses.push({ id, ...(linked ? { requestId: id } : {}), date: today, ...entry, source: 'user' });
        refresh(period, today);
        if (!linked) continue;
        const row = period.projection[day - 1]!;
        const spent = period.expenses.filter(expense => expense.date === today).reduce((sum, expense) => sum + expense.amount, 0);
        const level = row.remaining < 0 ? 'stop' : spent > row.allowance ? 'warn' : 'ok';
        requests[id] = {
          kind: 'expense', date: today, source: 'user', createdAt: `${today}T${String(10 + index).padStart(2, '0')}:00:00.000Z`,
          input: `I paid ${money(entry.amount)} for ${entry.note.toLowerCase()}.`, parsed: { ...entry },
          verdicts: {
            Pace: verdict('Expense recorded in the daily plan', `Spending recorded so far today is ${money(spent)} against an allowance of ${money(row.allowance)}.`, [figure('Today spent so far', spent), figure('Today allowance', row.allowance)], level),
            Anomaly: verdict(entry.amount >= 18000 ? 'An unusual one-off expense' : 'A routine daily expense', `${entry.note} cost ${money(entry.amount)}. The spending balance after this entry is ${money(row.remaining)}.`, [figure('This expense', entry.amount), figure('Remaining spending balance', row.remaining)], entry.amount >= 18000 ? 'warn' : 'ok'),
            Coach: verdict(row.remaining < 0 ? 'Pause optional spending' : 'Keep the next decision small', row.remaining < 0 ? `The budget is ${money(-row.remaining)} below zero. Avoid optional purchases and plan to cover the shortfall from the next salary.` : `There is ${money(row.remaining)} left after this entry. Keep checking the daily allowance before another optional expense.`, [figure('Remaining spending balance', row.remaining)], level),
          },
        };
      }
      for (const purchase of purchasePlans.filter(plan => plan.month === month && plan.day === day)) {
        const id = `history-${today}-purchase`;
        const simulation = simulateBudget(period, today, { amount: purchase.price });
        const obligations = upcomingObligations(period, today, 7);
        const level = purchase.decision === 'buy' ? 'ok' : purchase.decision === 'wait' ? 'warn' : 'stop';
        requests[id] = {
          kind: 'purchase', date: today, source: 'user', createdAt: `${today}T20:00:00.000Z`,
          input: `Can I buy ${purchase.item} for ${money(purchase.price)}?`,
          parsed: { item: purchase.item, price: purchase.price, category: purchase.item === 'weekend trip' ? 'travel' : 'shopping' }, simulation,
          verdicts: {
            Impact: verdict('Here is the effect on the remaining plan', `This purchase changes the spending balance from ${money(simulation.remaining.before)} to ${money(simulation.remaining.after)} and the next daily allowance by ${money(simulation.deltaPerDay)}.`, [figure('Balance before', simulation.remaining.before), figure('Balance after', simulation.remaining.after), figure('Next allowance change', simulation.deltaPerDay)], simulation.goesNegative ? 'stop' : 'ok'),
            Obligations: verdict('Bills remain separate from shopping money', `${money(obligations.total)} of reserved recurring bills fall due in the next seven days. The simulation already excludes all monthly recurring bills.`, [figure('Upcoming reserved bills', obligations.total)]),
            'Deal Check': verdict('Affordability is not proof of a bargain', `The quoted price is ${money(purchase.price)}. No live retailer or price-history check was performed; this advice only assesses the supplied price.`, [figure('Quoted price', purchase.price)], 'warn'),
            Alternatives: verdict(purchase.decision === 'buy' ? 'Choose the planned modest replacement' : 'Use what you already have for now', purchase.why, [figure('Cost avoided by not buying', purchase.price)], level),
          },
          judgement: { decision: purchase.decision, why: `${purchase.why} At this point the purchase would leave ${money(simulation.remaining.after)} in the spending budget.`, figures: [figure('Price', purchase.price), figure('Balance after purchase', simulation.remaining.after)] },
        };
      }
    }
    const closed = closePeriod(period, period.end);
    periods.push(closed.period);
    previousBalance = closed.finalBalance;
  }
  return { periods, requests };
}

// Importing this module (including from tests and the store) never writes a file.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(new URL('./history.json', import.meta.url), `${JSON.stringify(generateHistory(), null, 2)}\n`);
}
