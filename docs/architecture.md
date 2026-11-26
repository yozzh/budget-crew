# Architecture

Agreed with the owner on 2026-11-26. Issues refer to this document; when code and this document disagree, raise it in the issue instead of silently diverging.

## Principles

- **No orchestrator.** Every agent is a Mozaik participant with its own `SituationSpecification`s. It decides which events it reacts to and starts `runLoop` without `await`. This is where the required concurrency comes from.
- **Code computes money, LLMs interpret.** Projection, periods and `simulateBudget` are pure functions in `packages/budget` with tests. Agents get numbers only through tools.
- **One writer.** Agents only answer. The non-LLM participant **Ledger** is the only code that changes `BudgetState`: it records expenses and incomes, opens and closes periods, and stores each agent's verdict in that agent's own slot `requests[id].verdicts[agent]`.
- **Fresh context per loop.** Mozaik's `MessageReceivedState` appends the message to the `context` it is given. Passing the agent's memory would mix concurrent loops of the same agent. Every `runLoop` gets a new `ModelContext` with the agent's instruction and the one message.
- **Everything the Observer sees goes out.** The non-LLM participant **Observer** reacts to every runtime event and publishes to two Centrifugo channels. The 2D UI, the timelapse and the later 3D room read the same stream.
- **HTTP never waits for an LLM.** Commands answer `202 {requestId}`; results arrive through Centrifugo.
- **No LLM in tests or CI.** `INFERENCE=stub` swaps in a deterministic runner.

## Layout

```
apps/api          NestJS 11 (ESM): HTTP under /api, Mozaik runtime, Centrifugo publisher, serves apps/web/dist
apps/web          Vite + React 19; later src/room/ with react-three-fiber
packages/budget   pure budget math and its types, no dependencies
packages/shared   zod contracts: HTTP, runtime events, Centrifugo publications, agent output schemas
seed/             synthetic-user.json, month.json, price-history.json
deploy/           stand (compose, Centrifugo config, updater)
```

## Nest modules

| Module | Contents |
|---|---|
| `ConfigModule` | zod-validated env: `INFERENCE`, `OPENAI_API_KEY`, `MOZAIK_API_KEY`, `CENTRIFUGO_API_URL`, `CENTRIFUGO_API_KEY`, `PORT` |
| `BudgetModule` | `BudgetStore`: the only owner of `BudgetState`; uses `packages/budget` |
| `InferenceModule` | model list: Mozaik's `supportedModels` plus `gpt-6.2-sol` and `gpt-6.1-terra` (copies of the `gpt-6-luna` specification with another name); `StubInferenceRunner` when `INFERENCE=stub` |
| `CrewModule` | `CrewRuntime`: `defineRuntime<BudgetState>()`, `initializeRuntime` in `onModuleInit`, joins every participant; agent factories, tools, Ledger, Simulator |
| `RealtimeModule` | `CentrifugoPublisher` (`POST {CENTRIFUGO_API_URL}/publish`, header `X-API-Key`); Observer |
| `ApiModule` | controllers below, zod validation of input |
| `HealthModule` | `GET /api/health` |

Processors are plain classes that get `BudgetStore` and the publisher through the factory closure; no Nest DI inside Mozaik. Never `await runLoop` or `sendMessage` inside a processor.

## State

```ts
class BudgetState extends RuntimeState {
  profile: { name: string; currency: "EUR"; payday: number;            // day of month
             recurringArticles: { name: string; amount: number; dueDay: number }[] }
  periods: Period[]               // closed ones and at most one open
  currentPeriodId?: string        // none -> expenses and purchase checks answer 409 no_open_period
  today: ISODate
  requests: Record<RequestId, {
    kind: "expense" | "purchase" | "income"
    input: string
    parsed?: ParsedExpense | ParsedPurchase | ParsedIncome
    verdicts: Partial<Record<AgentName, Verdict | { status: "failed"; error: string }>>
    judgement?: Judgement
    createdAt: ISODateTime
  }>
  simulation: { running: boolean; day?: ISODate; speed: number }
}

type Period = {
  id: string; status: "open" | "closed"
  start: ISODate; end: ISODate       // end = day before the next payday
  salary: Income                     // the income that opened the period
  carryover: number                  // final balance of the previous period, may be negative
  extraIncomes: Income[]
  articles: PlannedArticle[]         // { id, name, amount, dueDate, paid }, copied from the profile template
  expenses: Expense[]                // { id, requestId, date, amount, category, note, source: "user" | "sim" }
  projection: DayProjection[]        // recomputed by Ledger after every write
  finalBalance?: number
}
```

In memory; on start the state is loaded from `seed/synthetic-user.json` with one open period, so the stand always opens in a demo-ready state. A restart resets it.

## Budget math (`packages/budget`)

Rewritten from scratch; `reference/daily-projection.ts` is only a description of the old algorithm.

- Residual of a period = salary + carryover − sum of planned articles.
- Period boundaries: from the salary date to the day before the next payday (`profile.payday`, clamped to the month length). A salary that arrives before the current period ends closes it the day before; its balance at that moment is the new period's carryover.
- Daily allowance at the start = residual / number of days.
- A day's actual spend differs from its allowance → the difference is spread evenly over the remaining days: `allowance += (allowance − expense) / futureDays`.
- A past day without spend, when `today` is set, counts as spent at plan.
- Several expenses on one day add up. The last day yields `finalBalance` and no next allowance.
- Extra income on day `d` is spread evenly over the days from `d` to the period end: `allowance += income / daysFromDInclusive`; the remaining balance grows by the whole amount.

```ts
projectDaily({ dates, residual, expensesByDate, incomesByDate, today }): DayProjection[]
openPeriod(profile, salary: Income, carryover: number): Period
closePeriod(period, closeDate): { period: Period; finalBalance: number }
simulateBudget(period, today, purchase: { amount: number; date?: ISODate }): {
  todayAllowance: { before; after }; nextAllowance: { before; after }
  deltaPerDay; remaining: { before; after }; daysLeft; goesNegative
}
upcomingObligations(period, today, horizonDays): { unpaid: PlannedArticle[]; total: number }
```

## Runtime events

Custom events: `sendEvent(SemanticEvent.create(type, producerId, payload), producerId)`. Payload schemas live in `packages/shared`.

| Type | Producer | Payload | Reacts |
|---|---|---|---|
| `expense.submitted` | Human, Simulator | `{requestId, text, date}` | Parser |
| `purchase.submitted` | Human, Simulator | `{requestId, text}` | Parser |
| `income.submitted` | Human, Simulator | `{requestId, text, date}` | Parser |
| `model.answer` (built in) | any agent | `{answer, loopId}` | Ledger (by `producerId`), Observer |
| `expense.recorded` | Ledger | `{requestId, expense, projectionToday}` | Pace, Anomaly, Coach |
| `income.recorded` | Ledger | `{requestId, income, projectionToday}` | Pace, Coach |
| `period.closed` | Ledger | `{periodId, finalBalance}` | Observer |
| `period.started` | Ledger | `{requestId, period}` | Planner, Obligations |
| `purchase.parsed` | Ledger | `{requestId, purchase}` | Impact, Obligations, Deal Check, Alternatives |
| `verdict.recorded` | Ledger | `{requestId, agent, verdict}` | Ledger (completeness), Observer |
| `purchase.ready` | Ledger | `{requestId, verdicts, simulation}` | Judge |
| `purchase.judged` | Ledger | `{requestId, judgement}` | Observer |
| `day.advanced`, `simulation.*` | Simulator | `{day}` | Ledger (`today`), Observer |
| `message_received.*`, `inference.*`, `function_call.*` | runtime | `{loopId, ...}` | Observer |

Linking a loop to its request: `runLoop` does not return a `loopId`. The processor starts the message with `[req:<requestId>]`; Observer maps `loopId → requestId` from `message_received.started`. A failed loop never reaches the processor: Ledger marks a verdict `failed` 45 seconds after the loop started, and Judge works with what it has.

## Agents

| Agent | Model | Reacts to | Tools | Output |
|---|---|---|---|---|
| Parser | `gpt-6-luna` | `*.submitted` | — | `ParsedExpense {amount, category, note}` / `ParsedPurchase {item, price, category}` / `ParsedIncome {amount, kind: salary \| extra, source}` |
| Planner | `gpt-6.1-terra` | `period.started` | `budget_snapshot`, `upcoming_obligations` | `Verdict`: plan of the period |
| Pace | `gpt-6.1-terra` | `expense.recorded`, `income.recorded` | `budget_snapshot` | `Verdict`: on pace or not, tomorrow's allowance |
| Anomaly | `gpt-6.1-terra` | `expense.recorded` | `category_stats` | `Verdict`: unusual for the category |
| Coach | `gpt-6.2-sol` | `expense.recorded`, `income.recorded` | `budget_snapshot` | `Verdict`: one sentence of advice |
| Impact | `gpt-6.1-terra` | `purchase.parsed` | `simulate_budget` | `Verdict` with before/after figures |
| Obligations | `gpt-6.1-terra` | `purchase.parsed`, `period.started` | `upcoming_obligations` | `Verdict`: enough left for obligations |
| Deal Check | `gpt-6.1-terra` | `purchase.parsed` | `price_history` (synthetic) | `Verdict`: is the discount real |
| Alternatives | `gpt-6.1-terra` | `purchase.parsed` | — | `Verdict`: cheaper, wait, skip |
| Judge | `gpt-6.2-sol` | `purchase.ready` | `simulate_budget` | `Judgement` |

```ts
Verdict   = { level: "ok" | "warn" | "stop"; headline: string /* ≤ 80 */; reason: string /* ≤ 280 */; figures?: { label: string; value: string }[] }
Judgement = { decision: "buy" | "wait" | "skip"; why: string; figures: { label: string; value: string }[] }
```

All agent outputs use `structuredOutput` with strict JSON schemas generated from the zod schemas. Non-LLM participants: Human (HTTP), Ledger, Simulator, Observer. UI and agent language: English.

## Centrifugo

Channels in namespace `crew` (anonymous subscribe, history 500 / 2h, forced recovery; `deploy/centrifugo/config.json`):

- `crew:activity` — what every agent is doing right now (activity feed, 3D room).
- `crew:state` — budget changes, verdicts, judgements, simulation progress.

```ts
type Envelope<T extends string, D> = { v: 1; type: T; at: ISODateTime; data: D }

// crew:activity
"agent.activity": { agent: AgentName; loopId: string; requestId?: string;
                    phase: "received" | "thinking" | "tool" | "answered" | "failed";
                    tool?: string; summary?: string }   // summary ≤ 120 chars, never prompts

// crew:state
"period.started":   { requestId, period }
"period.closed":    { periodId, finalBalance }
"income.recorded":  { requestId, income, projectionToday, remaining }
"expense.recorded": { requestId, expense, projectionToday, remaining }
"purchase.parsed":  { requestId, purchase }
"verdict.recorded": { requestId, agent, verdict }
"purchase.judged":  { requestId, judgement }
"simulation.tick":  { day, running }
"state.reset":      {}
```

Client: `GET /api/state` (snapshot, last 50 requests, channel stream positions) → `new Centrifuge(CENTRIFUGO_WS_URL)` without a token → subscribe to both channels from the snapshot positions → on `state.reset` or failed recovery, reload the snapshot. The browser URL is `wss://<host>/connection/websocket`; derive it from `location`, not from server config.

## HTTP API

| Method | Body → answer | Does |
|---|---|---|
| `POST /api/incomes` | `{text}` → `202 {requestId}` | `income.submitted`; a salary opens a new period |
| `POST /api/expenses` | `{text}` → `202 {requestId}`; `409 no_open_period` | `expense.submitted` |
| `POST /api/purchase-checks` | `{text}` → `202 {requestId}`; `409 no_open_period` | `purchase.submitted` |
| `GET /api/state` | snapshot + channel positions | initial screen load |
| `POST /api/simulation` | `{speed}` → `202`; `DELETE` stops | timelapse |
| `POST /api/reset` | `204` | back to seed, `state.reset` |
| `GET /api/health` | `{status, version, inference}` | stand and CI |

## Inference

- **live**: `OpenAIResponses` with the extended model list. Verified on 2026-11-26: all three models answer with strict JSON schemas, three loops started within 4 ms run concurrently.
- **stub**: a custom `InferenceRunner` (pattern of Mozaik's `custom-inference-runner` example): canned JSON per schema name, at most one tool call, 50–400 ms delay so concurrency is visible in tests and locally.
- **Mozaik cloud**: on when `MOZAIK_API_KEY` is set; one cloud session per loop.

## 3D room (after MVP)

Reads only `crew:activity` and `crew:state`. One agent = one low-poly character at its desk. `received`: looks up, a request card pops over the desk; `thinking`: types, monitor glows; `tool`: turns to the shared budget board; `answered`: sends a paper to Judge's desk, coloured by verdict level; `failed`: shrugs.

## Simulation

Simulator resets to seed without an open period and walks `seed/month.json`: day 1 a salary (`income.submitted`, opens the period), then `day.advanced` and `expense.submitted` for each expense of the day, a side income mid-month, and on Black Friday a series of `purchase.submitted`. It steps by time and never waits for agents; started manually.

## Tests

- `packages/budget`: required. Cases: even period without spend; overspend and underspend; several expenses a day; past day without spend; last day; purchase going negative; extra income mid-period; period boundaries by payday (month end, February); an early salary closing the period with carryover, including a negative one.
- One runtime integration test in stub mode per flow: the event chain ends with the expected verdicts in state and the agent loops overlap in time. Centrifugo is replaced by a recording publisher.
- No Playwright, no live models.
