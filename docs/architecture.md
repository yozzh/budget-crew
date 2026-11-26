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
    error?: string                   // Parser validation failure; no expense is recorded
    status?: "cancelled"
    reason?: "simulation_stopped"
    verdicts: Partial<Record<AgentName, Verdict | { status: "failed"; error: string } | { status: "cancelled"; reason: "simulation_stopped" }>>
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

type DayProjection = {
  date: ISODate
  allowance: number                 // start-of-day allowance, rounded to cents
  expense: number                   // actual or assumed historical spend, in cents
  remaining: number                 // exact balance after this day's accounted spend
  nextAllowance?: number            // after today's redistribution; absent on last day
  finalBalance?: number             // exact remaining on last day only
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

All stored money is integer euro cents. Internal allowances retain fractional cents; returned allowances are rounded. An assumed past spend is booked in whole cents so balances remain exact. Missing current/future spend is unknown and does not redistribute; an explicitly recorded zero does. Planned articles are reserved once, regardless of `paid`; paying an article must not also debit discretionary expenses.

Early closure preserves the original daily plan through the close date (inclusive), then marks that day's balance final; it must not redivide the residual over the shorter period and retroactively consume the carryover. `openPeriod` does not close another period: the caller passes that balance into the next period.

`simulateBudget` returns today's start allowance and remaining balance after today's spend; next allowance is the next day's start allowance (including its income), or `undefined` on the last day. `deltaPerDay` is after minus before for that next allowance, zero on the last day. `daysLeft` includes today. Purchases default to today and can be dated through period end; `goesNegative` checks projected balances and allowances from today onward. `upcomingObligations` includes unpaid articles from today through today + horizonDays, both inclusive.

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
| `request.failed` | Ledger | `{requestId, error}` | clients via `crew:state` |
| `request.cancelled` | Simulator | `{requestId, request: RequestState}` | runtime and clients via `crew:state` |
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

Expense and income loops are correlated by `(producerId, loopId)` and the original request object. Reset clears pending timers and correlations; late answers cannot recreate old requests or overwrite finished verdict slots. Invalid Parser output sets `requests[id].error` and publishes `request.failed` to both runtime and `crew:state`. Extra income without an open period fails with `no_open_period`. Salary publishes `period.closed` before `period.started`; completion waits for Planner and Obligations, while extra income waits for Pace and Coach. Offline fixtures use `ParsedExpense`, `ParsedIncome`, `PlannerVerdict`, `ObligationsVerdict`, `PaceVerdict`, `AnomalyVerdict`, and `CoachVerdict`; they are canned, not free-text parsing. Tests register salary/extra fixtures explicitly.

Purchase checks share the same Parser and Ledger with expense requests. `POST /api/purchase-checks` validates `{text}` and returns `202 {requestId}`, `400 invalid_input`, or `409 no_open_period`. Parsing stores a proposed purchase without recording an expense or changing the period projection. Four independent adviser loops start on `purchase.parsed`; Ledger fills missing slots with `failed` after 45 seconds and emits exactly one `purchase.ready` once all slots exist. Judge receives the purchase, all slots and deterministic simulation; Ledger stores its validated answer and publishes `purchase.judged`. Reset and late-answer guards apply to purchase loops too.

Stopping a simulation cancels only its unfinished requests, publishing one `request.cancelled` with the full final request state per request. Cancellation sets `status: "cancelled"` and `reason: "simulation_stopped"`; empty expected slots (including Parser and Judge when applicable) receive the same cancellation slot. Answered and failed slots, parsed data, recorded money and completed judgements remain unchanged. Expense completion requires Pace, Anomaly and Coach; salary requires Planner and Obligations; extra income requires Pace and Coach; purchases require Judge. Cancelled requests render as terminal **Stopped**, including after snapshot reload or when the cancellation is the first event seen for that request.


Income and purchase paths also share one Obligations participant reacting independently to `period.started` and `purchase.parsed`; concurrent loops retain separate request contexts and verdict slots.

Purchase tools are read-only wrappers: `simulate_budget({amount})` and `upcoming_obligations({horizonDays})` use the current open period and today; `price_history({item})` reads synthetic 90-day histories for ten products in `seed/price-history.json`, with unknown items returning `{status:"unknown"}`. These are not live quotes. Offline fixtures add `ParsedPurchase`, `ImpactVerdict`, `ObligationsVerdict`, `DealCheckVerdict`, `AlternativesVerdict`, and `Judgement`; tool-bearing fixtures invoke the actual tools, while answers remain canned.

Money crosses the LLM boundary as display strings with two decimals (`€1,234.56`, `-€12.40`). Expense and purchase tools format every monetary field, including nested projections, obligations and price histories; counts and days remain numbers. Non-Parser agent contexts use the same adapter, including period events and Judge's simulation. Agents quote those strings unchanged, without conversions. `simulate_budget` accepts the purchase's nonnegative euro string and converts it internally. Parser instructions and outputs, runtime events, ledger storage and shared API contracts remain integer cents; only the LLM-facing copies are formatted.

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
"request.failed":   { requestId, error }
"request.cancelled": { requestId, request: RequestState }
"period.started":   { requestId, period }
"period.closed":    { periodId, finalBalance }
"income.recorded":  { requestId, income, projectionToday, remaining }
"expense.recorded": { requestId, expense, projectionToday, remaining }
"purchase.parsed":  { requestId, purchase }
"verdict.recorded": { requestId, agent, verdict }
"purchase.judged":  { requestId, judgement }
"simulation.tick":  { day, running, speed }
"simulation.finished": { day, running: false, speed }
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
| `POST /api/simulation` | `{speed?: number}` → `202`; running → `409`; `DELETE` → `204` | seconds/day, default 4 |
| `POST /api/reset` | `204` | back to seed, `state.reset` |
| `GET /api/health` | `{status, version, inference}` | stand and CI |

## Inference

- **live**: `OpenAIResponses` with the extended model list. Verified on 2026-11-26: all three models answer with strict JSON schemas, three loops started within 4 ms run concurrently.
- **stub**: a custom `InferenceRunner` (pattern of Mozaik's `custom-inference-runner` example): canned JSON per schema name, at most one tool call, 50–400 ms delay so concurrency is visible in tests and locally.
- **Mozaik cloud**: on when `MOZAIK_API_KEY` is set; one cloud session per loop.

## 3D room (after MVP)

Reads only `crew:activity` and `crew:state`. One agent = one low-poly character at its desk. `received`: looks up, a request card pops over the desk; `thinking`: types, monitor glows; `tool`: turns to the shared budget board; `answered`: sends a paper to Judge's desk, coloured by verdict level; `failed`: shrugs.

## Simulation

Simulator is a non-LLM participant registered in `CrewModule`. It resets the synthetic profile without an open period and walks all 30 days of `seed/month.json`. Each tick sends `day.advanced` first, then income, expense and purchase submissions with immutable dates, `source: "sim"` and a run identifier. Day 1's salary opens the period through Parser/Ledger; Ledger queues parsed simulated expenses until that salary arrives. The clock never waits for agents.

`simulation.tick` and `simulation.finished` publish progress to `crew:state`; snapshots retain running/day/speed. Natural finish stops the clock but lets outstanding agents complete. DELETE, reset and shutdown cancel timers and invalidate outstanding simulated submissions, adviser deadlines and late publications.

The dashboard controls speed in seconds/day (default 4), displays the simulated day and charts the original salary/carryover plan against every day's actual API projection. Projection-changing events trigger snapshot resynchronization, including publications received during a snapshot fetch, so future redistribution and extra income are not reduced to a single point update.

## Tests

- `packages/budget`: required. Cases: even period without spend; overspend and underspend; several expenses a day; past day without spend; last day; purchase going negative; extra income mid-period; period boundaries by payday (month end, February); an early salary closing the period with carryover, including a negative one.
- One runtime integration test in stub mode per flow: the event chain ends with the expected verdicts in state and the agent loops overlap in time. Centrifugo is replaced by a recording publisher.
- No Playwright, no live models.
