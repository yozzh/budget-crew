import "reflect-metadata";
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { OpenAIResponses, type InferenceInput, type InferenceOutput } from "@mozaik-ai/core";
import type { RequestState } from "@budget-crew/shared";
import { afterAll, expect, it, vi } from "vitest";
import { BudgetStore } from "../budget/budget.store.js";
import { CrewModule } from "../crew/crew.module.js";
import { ExpenseFlow } from "../crew/expense-flow.js";
import { CentrifugoPublisher } from "../realtime/centrifugo.publisher.js";
import { scenarios, type Scenario } from "./scenarios.js";

/**
 * Live crew evaluation: real models, never part of `pnpm test` or CI.
 * INFERENCE=live OPENAI_BASE_URL=... OPENAI_API_KEY=... pnpm --filter @budget-crew/api eval:live
 * EVAL_ONLY=P1-kindle-early,E2-grocery-spike  EVAL_REPEATS=2  EVAL_WORKERS=3  EVAL_LABEL=round-1
 */
const live = process.env.INFERENCE === "live" && process.env.OPENAI_BASE_URL !== undefined;
const only = process.env.EVAL_ONLY?.split(",").map(id => id.trim()).filter(Boolean);
const repeats = Number(process.env.EVAL_REPEATS ?? 1);
const workers = Number(process.env.EVAL_WORKERS ?? 3);
const label = process.env.EVAL_LABEL ?? "run";
const money = /-?€\d{1,3}(?:,\d{3})*\.\d{2}/g;

interface Call {
  requestId?: string; schema?: string; model: string; ms: number; error?: string;
  input: string; output: { type: string; name?: string; args?: string; text?: string }[];
  tokens?: unknown;
}
interface Check { name: string; pass: boolean; detail?: string }
interface Result {
  scenario: string; repeat: number; borderline: boolean; holdout: boolean; ms: number; checks: Check[];
  request?: RequestState; calls: Call[]; moneyViolations: string[]; toolSkips: string[];
}

const calls: Call[] = [];
const results: Result[] = [];

function plainItem(item: unknown): Call["output"][number] {
  const value = JSON.parse(JSON.stringify(item)) as Record<string, unknown>;
  const text = (value.content as { text?: string } | undefined)?.text ?? value.text;
  return { type: String(value.type ?? (item as object).constructor.name), name: value.name as string | undefined,
    args: value.args as string | undefined, text: typeof text === "string" ? text : undefined };
}

function recordCalls(): void {
  const original = OpenAIResponses.prototype.infer;
  vi.spyOn(OpenAIResponses.prototype, "infer").mockImplementation(async function (this: OpenAIResponses, input: InferenceInput) {
    const mapper = (this as unknown as { endpointMapper: { toRequest(i: InferenceInput): unknown } }).endpointMapper;
    const request = JSON.stringify(mapper.toRequest(input));
    const call: Call = { requestId: /\[req:([^\]\\]+)\]/.exec(request)?.[1], schema: input.structuredOutput?.name,
      model: input.model, ms: 0, input: request, output: [] };
    const started = Date.now();
    try {
      const output: InferenceOutput = await original.call(this, input);
      call.output = output.items.map(plainItem);
      call.tokens = output.tokenUsage;
      return output;
    } catch (error) {
      call.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      call.ms = Date.now() - started;
      calls.push(call);
    }
  });
}

const expectedAgents = (request: RequestState): string[] => request.kind === "expense" ? ["Pace", "Anomaly", "Coach"]
  : request.kind === "purchase" ? ["Impact", "Obligations", "Deal Check", "Alternatives"]
    : request.parsed && "kind" in request.parsed && request.parsed.kind === "salary" ? ["Planner", "Obligations"] : ["Pace", "Coach"];

function settled(request: RequestState | undefined): boolean {
  if (!request) return false;
  if (request.error) return true;
  if (request.kind === "purchase") return request.judgement !== undefined;
  return request.parsed !== undefined && expectedAgents(request).every(agent => request.verdicts[agent as never]);
}

function texts(request: RequestState, agent?: string): string[] {
  const out: string[] = [];
  for (const [name, slot] of Object.entries(request.verdicts)) {
    if ((agent === undefined || agent === name) && slot && "headline" in slot) out.push(`${slot.headline} ${slot.reason}`);
  }
  if ((agent === undefined || agent === "Judge") && request.judgement) out.push(request.judgement.why);
  return out;
}

function grade(scenario: Scenario, request: RequestState | undefined, requestCalls: Call[]): Pick<Result, "checks" | "moneyViolations" | "toolSkips"> {
  const checks: Check[] = [];
  const { expect: want } = scenario;
  const check = (name: string, pass: boolean, detail?: string) => checks.push({ name, pass, detail });
  if (!request || !settled(request)) {
    check("settled", false, "timeout");
    return { checks, moneyViolations: [], toolSkips: [] };
  }
  if (request.error) check("no_error", want.mayFail === true, request.error);
  const parsed = request.parsed as Record<string, unknown> | undefined;
  if (want.amount !== undefined) check("amount", parsed?.amount === want.amount, `got ${String(parsed?.amount)}`);
  if (want.price !== undefined) check("price", parsed?.price === want.price, `got ${String(parsed?.price)}`);
  if (want.incomeKind) check("income_kind", parsed?.kind === want.incomeKind, `got ${String(parsed?.kind)}`);
  if (want.category) check("category", want.category.test(String(parsed?.category)), `got ${String(parsed?.category)}`);
  if (want.item) check("item", want.item.test(String(parsed?.item)), `got ${String(parsed?.item)}`);
  if (!request.error) {
    for (const agent of expectedAgents(request)) {
      const slot = request.verdicts[agent as never] as { status?: string; error?: string } | undefined;
      check(`verdict_${agent}`, slot !== undefined && slot.status === undefined, slot?.error);
    }
    for (const [agent, levels] of Object.entries(want.levels ?? {})) {
      const slot = request.verdicts[agent as never] as { level?: string } | undefined;
      check(`level_${agent}`, slot?.level !== undefined && levels.includes(slot.level as never), `got ${slot?.level ?? "none"}, want ${levels.join("|")}`);
    }
    if (want.decision) {
      check("decision", request.judgement !== undefined && want.decision.includes(request.judgement.decision),
        `got ${request.judgement?.decision ?? "none"}, want ${want.decision.join("|")}`);
    }
    if (want.mentions) check("mentions", texts(request).some(text => want.mentions!.test(text)), String(want.mentions));
    if (want.forbid) {
      const hit = texts(request, want.forbid.agent).find(text => want.forbid!.pattern.test(text));
      check(`forbid_${want.forbid.agent}`, hit === undefined, hit);
    }
  } else if (want.decision) {
    check("decision", true, `request failed safely: ${request.error}`);
  }
  // Every euro string an agent outputs must have been supplied to it (prompt or tool result).
  const moneyViolations: string[] = [];
  const toolSkips: string[] = [];
  const bySchema = new Map<string, Call[]>();
  for (const call of requestCalls) bySchema.set(call.schema ?? "?", [...(bySchema.get(call.schema ?? "?") ?? []), call]);
  for (const [schema, group] of bySchema) {
    const hasTools = group.some(call => /"tools":\[\{/.test(call.input));
    if (hasTools && !group.some(call => call.output.some(item => item.name))) toolSkips.push(schema);
    for (const call of group) {
      for (const item of call.output) {
        for (const amount of item.text?.match(money) ?? []) {
          if (!call.input.includes(amount)) moneyViolations.push(`${schema}: ${amount}`);
        }
      }
    }
  }
  check("money_quoted", moneyViolations.length === 0, moneyViolations.join(", "));
  return { checks, moneyViolations, toolSkips };
}

async function runOne(app: INestApplicationContext, scenario: Scenario, repeat: number): Promise<Result> {
  const store = app.get(BudgetStore);
  const flow = app.get(ExpenseFlow);
  store.reset((scenario.periodOf ?? scenario.today) as never);
  if (scenario.periodOf) store.setToday(scenario.today as never);
  const started = Date.now();
  const { requestId } = scenario.kind === "expense" ? flow.submit(scenario.text)
    : scenario.kind === "income" ? flow.submitIncome(scenario.text) : flow.submitPurchase(scenario.text);
  while (!settled(store.state.requests[requestId]) && Date.now() - started < 240_000) await sleep(250);
  // Late adviser answers after a parser error are irrelevant; give the last verdict a moment to land.
  await sleep(300);
  const request = structuredClone(store.state.requests[requestId]);
  const requestCalls = calls.filter(call => call.requestId === requestId);
  return { scenario: scenario.id, repeat, borderline: scenario.borderline === true, holdout: scenario.holdout === true, ms: Date.now() - started,
    request, calls: requestCalls, ...grade(scenario, request, requestCalls) };
}

function summary(): string {
  const strict = results.filter(r => !r.borderline);
  const passed = (r: Result) => r.checks.every(c => c.pass);
  const rate = (rs: Result[], pick: (c: Check) => boolean) => {
    const cs = rs.flatMap(r => r.checks.filter(pick));
    return cs.length ? `${cs.filter(c => c.pass).length}/${cs.length}` : "-";
  };
  const latencies = calls.filter(c => !c.error).map(c => c.ms).sort((a, b) => a - b);
  const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? 0;
  const lines = [
    `# Crew live eval: ${label}`, "",
    `Runs: ${results.length} (${strict.filter(passed).length}/${strict.length} strict pass, ${results.filter(r => r.borderline && passed(r)).length}/${results.filter(r => r.borderline).length} borderline pass)`,
    `Hold-out: ${results.filter(r => r.holdout && passed(r)).length}/${results.filter(r => r.holdout).length} pass`,
    `Model calls: ${calls.length}, errors: ${calls.filter(c => c.error).length}, latency p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms`, "",
    "| Check | Pass |", "|---|---|",
    `| parsing (amount/price/kind/category/item) | ${rate(results, c => ["amount", "price", "income_kind", "category", "item"].includes(c.name))} |`,
    `| verdict levels | ${rate(results, c => c.name.startsWith("level_"))} |`,
    `| judge decision | ${rate(strict, c => c.name === "decision")} |`,
    `| adviser completed (no timeout/invalid) | ${rate(results, c => c.name.startsWith("verdict_"))} |`,
    `| money quoted from inputs | ${rate(results, c => c.name === "money_quoted")} |`,
    `| semantic (mentions/forbid) | ${rate(results, c => c.name === "mentions" || c.name.startsWith("forbid_"))} |`,
    "", "| Scenario | # | Result | Failed checks | Tool skipped | Decision / levels |", "|---|---|---|---|---|---|",
  ];
  for (const r of results) {
    const failed = r.checks.filter(c => !c.pass).map(c => `${c.name}${c.detail ? ` (${c.detail})` : ""}`).join("; ");
    const levels = Object.entries(r.request?.verdicts ?? {}).map(([a, v]) => `${a}:${"level" in v ? v.level : "status" in v ? v.status : "?"}`).join(" ");
    lines.push(`| ${r.scenario}${r.borderline ? " (b)" : ""} | ${r.repeat} | ${passed(r) ? "pass" : "FAIL"} | ${failed.replaceAll("|", "/")} | ${r.toolSkips.join(", ")} | ${r.request?.judgement?.decision ?? r.request?.error ?? ""} ${levels} |`);
  }
  return lines.join("\n");
}

afterAll(() => {
  if (!live || results.length === 0) return;
  const dir = new URL(`../../eval-reports/${new Date().toISOString().replaceAll(":", "-")}-${label}/`, import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL("results.json", dir), JSON.stringify(results, null, 2));
  writeFileSync(new URL("summary.md", dir), summary());
  console.log(summary());
});

it.skipIf(!live)("crew answers synthetic financial situations", { timeout: 3_600_000 }, async () => {
  vi.stubEnv("MOZAIK_API_KEY", "");
  vi.spyOn(CentrifugoPublisher.prototype, "publish").mockResolvedValue(undefined);
  recordCalls();
  const queue = scenarios.filter(s => !only?.length || only.includes(s.id))
    .flatMap(s => Array.from({ length: repeats }, (_, repeat) => ({ s, repeat: repeat + 1 })));
  expect(queue.length).toBeGreaterThan(0);
  await Promise.all(Array.from({ length: Math.min(workers, queue.length) }, async () => {
    // One Nest application per worker: separate store and Mozaik runtime.
    const app = await NestFactory.createApplicationContext(CrewModule, { logger: ["error"] });
    try {
      for (let job = queue.shift(); job; job = queue.shift()) results.push(await runOne(app, job.s, job.repeat));
    } finally { await app.close(); }
  }));
});
