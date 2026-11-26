import type {
  BudgetSimulation as DomainBudgetSimulation,
  DayProjection as DomainDayProjection,
  Expense as DomainExpense,
  Income as DomainIncome,
  ISODate as DomainISODate,
  Period as DomainPeriod,
  PlannedArticle as DomainPlannedArticle,
  Profile as DomainProfile,
} from "@budget-crew/budget";
import { z } from "zod";

// ISO dates validated by Zod also satisfy the budget package's date template type.
export const ISODate = z.iso.date() as z.ZodType<DomainISODate>;
export type ISODate = DomainISODate;

export const Income = z.strictObject({
  id: z.string(),
  requestId: z.string().optional(),
  date: ISODate,
  amount: z.int().nonnegative(),
  source: z.string(),
  kind: z.enum(["salary", "extra"]),
}) satisfies z.ZodType<DomainIncome>;
export type Income = DomainIncome;

export const Expense = z.strictObject({
  id: z.string(),
  requestId: z.string().optional(),
  date: ISODate,
  amount: z.int().nonnegative(),
  category: z.string(),
  note: z.string(),
  source: z.enum(["user", "sim"]),
}) satisfies z.ZodType<DomainExpense>;
export type Expense = DomainExpense;

export const PlannedArticle = z.strictObject({
  id: z.string(),
  name: z.string(),
  amount: z.int().nonnegative(),
  dueDate: ISODate,
  paid: z.boolean(),
}) satisfies z.ZodType<DomainPlannedArticle>;
export type PlannedArticle = DomainPlannedArticle;

export const Profile = z.strictObject({
  name: z.string(),
  currency: z.literal("EUR"),
  payday: z.int().min(1).max(31),
  recurringArticles: z.array(z.strictObject({
    name: z.string(),
    amount: z.int().nonnegative(),
    dueDay: z.int().min(1).max(31),
  })),
}) satisfies z.ZodType<DomainProfile>;
export type Profile = DomainProfile;

export const DayProjection = z.strictObject({
  date: ISODate,
  allowance: z.int(),
  expense: z.int().nonnegative(),
  remaining: z.int(),
  nextAllowance: z.int().optional(),
  finalBalance: z.int().optional(),
}) satisfies z.ZodType<DomainDayProjection>;
export type DayProjection = DomainDayProjection;

export const Period = z.strictObject({
  id: z.string(),
  status: z.enum(["open", "closed"]),
  start: ISODate,
  end: ISODate,
  salary: Income,
  carryover: z.int(),
  extraIncomes: z.array(Income),
  articles: z.array(PlannedArticle),
  expenses: z.array(Expense),
  projection: z.array(DayProjection),
  finalBalance: z.int().optional(),
}) satisfies z.ZodType<DomainPeriod>;
export type Period = DomainPeriod;

// JSON omits undefined next-day allowances on a period's final day.
export type BudgetSimulation = Omit<DomainBudgetSimulation, "nextAllowance"> & {
  nextAllowance: Partial<DomainBudgetSimulation["nextAllowance"]>;
};
const BeforeAfter = z.strictObject({ before: z.number(), after: z.number() });
export const BudgetSimulation = z.strictObject({
  todayAllowance: BeforeAfter,
  nextAllowance: BeforeAfter.partial(),
  deltaPerDay: z.number(),
  remaining: BeforeAfter,
  daysLeft: z.int().positive(),
  goesNegative: z.boolean(),
}) satisfies z.ZodType<BudgetSimulation>;
