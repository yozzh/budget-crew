import { describe, expect, it } from 'vitest';
import { closePeriod, openPeriod, projectDaily, simulateBudget, upcomingObligations } from './index.js';
import type { Expense, Income, ISODate, Profile } from './index.js';

const dates: ISODate[] = ['2026-11-01', '2026-11-02', '2026-11-03'];
const profile: Profile = { name: 'Demo', currency: 'EUR', payday: 1, recurringArticles: [] };
const salary: Income = { id: 'salary', date: '2026-11-01', amount: 30000, source: 'demo', kind: 'salary' };
const expense = (date: ISODate, amount: number): Expense => ({ id: `${date}:${amount}`, date, amount, category: 'food', note: '', source: 'user' });

it('even period without spend', () => {
  const rows = projectDaily({ dates, residual: 300 });
  expect(rows.map(row => row.allowance)).toEqual([100, 100, 100]);
  expect(rows.map(row => row.remaining)).toEqual([300, 300, 300]);
});

it('overspend redistributed over the remaining days', () => {
  const rows = projectDaily({ dates, residual: 300, expensesByDate: { '2026-11-01': 160 } });
  expect(rows.map(row => row.allowance)).toEqual([100, 70, 70]);
  expect(rows[0]?.remaining).toBe(140);
});

it('underspend redistributed over the remaining days', () => {
  expect(projectDaily({ dates, residual: 300, expensesByDate: { '2026-11-01': 40 } }).map(row => row.allowance)).toEqual([100, 130, 130]);
});

it('several expenses on one day summed', () => {
  const period = openPeriod(profile, salary, 0);
  period.expenses = [expense('2026-11-01', 400), expense('2026-11-01', 600)];
  const result = simulateBudget(period, '2026-11-01', { amount: 0 });
  expect(result.remaining.before).toBe(29000);
  expect(result.nextAllowance.before).toBe(1000);
});

it('a past day without spend counted at plan when today is set', () => {
  const rows = projectDaily({ dates, residual: 300, today: '2026-11-02' });
  expect(rows[0]).toMatchObject({ expense: 100, remaining: 200, nextAllowance: 100 });
  expect(rows[1]).toMatchObject({ expense: 0, remaining: 200 });
});

it('last day gives finalBalance and no next allowance', () => {
  const rows = projectDaily({ dates, residual: 300, expensesByDate: { '2026-11-01': 160, '2026-11-03': 150 } });
  expect(rows[2]).toEqual({ date: '2026-11-03', allowance: 70, expense: 150, remaining: -10, finalBalance: -10 });
  const result = simulateBudget(openPeriod(profile, salary, 0), '2026-11-30', { amount: 1001 });
  expect(result.nextAllowance).toEqual({ before: undefined, after: undefined });
  expect(result.goesNegative).toBe(true);
});

it('purchase that makes the period go negative sets goesNegative', () => {
  const result = simulateBudget(openPeriod(profile, salary, 0), '2026-11-01', { amount: 30001 });
  expect(result.goesNegative).toBe(true);
  expect(result.remaining).toEqual({ before: 30000, after: -1 });
  expect(result.todayAllowance).toEqual({ before: 1000, after: 1000 });
  expect(result.nextAllowance.after).toBe(0);
});

it('extra income mid-period raises the allowance from its date', () => {
  const rows = projectDaily({ dates, residual: 300, incomesByDate: { '2026-11-02': 80 } });
  expect(rows.map(row => row.allowance)).toEqual([100, 140, 140]);
  expect(rows.map(row => row.remaining)).toEqual([300, 380, 380]);
});

describe('period boundaries', () => {
  it.each([
    ['2026-11-01', '2026-11-30', 30],
    ['2026-12-01', '2026-12-31', 31],
  ] as const)('payday 1 in 30- and 31-day months: %s', (date, end, length) => {
    const period = openPeriod(profile, { ...salary, date }, 0);
    expect(period.end).toBe(end);
    expect(period.projection).toHaveLength(length);
  });
  it.each([
    ['2026-01-31', '2026-02-27'],
    ['2024-01-31', '2024-02-28'],
    ['2026-02-28', '2026-03-30'],
    ['2024-02-29', '2024-03-30'],
  ] as const)('payday 31 in February: %s', (date, end) => {
    expect(openPeriod({ ...profile, payday: 31 }, { ...salary, date }, 0).end).toBe(end);
  });
  it('early salary uses the nearest payday strictly after its date', () => {
    expect(openPeriod({ ...profile, payday: 15 }, { ...salary, date: '2026-11-10' }, 0).end).toBe('2026-11-14');
  });
});

it.each([500, 31000])('an early salary closes the period the day before with carryover, including negative carryover: %s', amount => {
  const period = openPeriod(profile, salary, 0);
  period.expenses = [expense('2026-11-01', amount)];
  const original: typeof period = JSON.parse(JSON.stringify(period));
  const closed = closePeriod(period, '2026-11-01');
  expect(closed.finalBalance).toBe(30000 - amount);
  expect(closed.period).toMatchObject({ status: 'closed', end: '2026-11-01', finalBalance: 30000 - amount });
  expect(openPeriod(profile, { ...salary, id: 'early', date: '2026-11-02' }, closed.finalBalance).carryover).toBe(30000 - amount);
  expect(period).toEqual(original);
});

it('early closure preserves the allowance in force before the early salary', () => {
  const closed = closePeriod(openPeriod(profile, salary, 0), '2026-11-10');
  expect(closed.finalBalance).toBe(20000);
  expect(closed.period.projection[9]).toMatchObject({ allowance: 1000, finalBalance: 20000 });
  expect(closed.period.projection[9]).not.toHaveProperty('nextAllowance');
});

it('sum of rounded allowances differs from residual by less than one cent per day', () => {
  const rows = projectDaily({ dates, residual: 100 });
  expect(Math.abs(rows.reduce((sum, row) => sum + row.allowance, 0) - 100)).toBeLessThan(dates.length);
  expect(projectDaily({ dates, residual: 100, today: '2026-11-04' }).at(-1)?.remaining).toBe(0);
});

it('simulateBudget does not mutate its input and respects a future purchase date', () => {
  const period = openPeriod(profile, salary, 0);
  const original: typeof period = JSON.parse(JSON.stringify(period));
  const result = simulateBudget(period, '2026-11-01', { amount: 300, date: '2026-11-03' });
  expect(period).toEqual(original);
  expect(result.nextAllowance).toEqual({ before: 1000, after: 1000 });
  expect(result.goesNegative).toBe(false);
  const immediate = simulateBudget(period, '2026-11-01', { amount: 1290 });
  expect(immediate.nextAllowance).toEqual({ before: 1000, after: 990 });
  expect(immediate.deltaPerDay).toBe(-10);
  expect(immediate.daysLeft).toBe(30);
});

it('upcomingObligations includes only unpaid articles within the inclusive calendar horizon', () => {
  const period = openPeriod(profile, salary, 0);
  period.articles = [
    { id: 'past', name: 'Past', amount: 10, dueDate: '2026-11-01', paid: false },
    { id: 'paid', name: 'Paid', amount: 20, dueDate: '2026-11-02', paid: true },
    { id: 'now', name: 'Now', amount: 30, dueDate: '2026-11-02', paid: false },
    { id: 'edge', name: 'Edge', amount: 40, dueDate: '2026-11-04', paid: false },
    { id: 'later', name: 'Later', amount: 50, dueDate: '2026-11-05', paid: false },
  ];
  const result = upcomingObligations(period, '2026-11-02', 2);
  expect(result.unpaid.map(article => article.id)).toEqual(['now', 'edge']);
  expect(result.total).toBe(70);
});

it('openPeriod copies and reserves profile articles once, clamping their due days', () => {
  const recurringArticles = [{ name: 'Rent', amount: 10000, dueDay: 31 }];
  const period = openPeriod({ ...profile, recurringArticles }, { ...salary, date: '2026-02-01' }, -1000);
  expect(period.articles[0]).toMatchObject({ name: 'Rent', amount: 10000, dueDate: '2026-02-28', paid: false });
  expect(period.projection[0]?.remaining).toBe(19000);
  recurringArticles[0]!.amount = 1;
  expect(period.articles[0]?.amount).toBe(10000);
  period.articles[0]!.paid = true;
  expect(simulateBudget(period, '2026-02-01', { amount: 0 }).remaining.before).toBe(19000);
});
