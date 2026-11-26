# Daily Budget Crew

A crew of concurrent [Mozaik](https://www.npmjs.com/package/@mozaik-ai/core) agents around a daily budget. Built for the JigJoy Black Friday AI Hackathon (track: AI agents in finance). All data is synthetic.

## Run

Requires Node 24 and pnpm 12.

```sh
pnpm install
cp .env.example .env
pnpm build
pnpm start            # http://localhost:3000, health at /api/health
```

Full stack with Centrifugo: `docker compose -f deploy/compose.yaml --env-file .env up --build` (set `CENTRIFUGO_HTTP_API_KEY` first).

## Budget state

`GET /api/state` returns the in-memory snapshot and the latest 50 requests.
The synthetic Alex/EUR seed opens a period in the current UTC month; all money
is integer euro cents. Restarting or `POST /api/reset` restores this seed.
Reset responds with 204 after publishing `state.reset` on `crew:state`.
Set `CENTRIFUGO_API_URL` and `CENTRIFUGO_API_KEY` for delivery;
reset publication failures are surfaced as HTTP errors.

`BudgetModule` exports the single `BudgetStore`. Runtime consumers must use
`store.state` (a Mozaik `RuntimeState`) rather than construct a second state;
reset preserves that object's identity and its participant registry.
`snapshot()` returns an isolated copy; the store retains at most 200 requests.
Contracts and strict agent-output JSON schemas are exported by
`@budget-crew/shared`. Stream positions are intentionally not included yet.

## Crew runtime

`INFERENCE` is validated at startup and defaults to `stub`; health reports the
validated mode. `live` requires `OPENAI_API_KEY` and supports `gpt-6-luna`,
`gpt-6.2-sol` and `gpt-6.1-terra`. Stub loops never enable Mozaik cloud telemetry,
even when credentials are present.

Join participants through `CrewRuntime.join`, dispatch custom events through
`sendEvent`, and call `startLoop(agent, requestId, message, structuredOutput,
tools?, model?)` from their processors without awaiting. Each loop gets a fresh
developer/user context; agent memory is not reused.

Before starting a stub loop, register its named output using
`StubInferenceRunner.registerFixture(name, zodSchema, value, functionCall?)`.
Fixtures are validated when registered; unknown schema names fail explicitly.
The optional function call is `{ name, args }` and executes at most once per loop.
Stub inference waits 50–400 ms per turn so overlapping loops remain observable.

Observer publishes versioned `agent.activity` envelopes to `crew:activity`;
`requestId` follows the loop's `[req:…]` prefix. Prompts and answers are not
included in summaries. Set `CENTRIFUGO_API_URL` (default
`http://127.0.0.1:8000/api`) and `CENTRIFUGO_API_KEY` for delivery; publication
failures are logged without stopping loops.
