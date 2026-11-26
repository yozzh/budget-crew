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
Reset responds with 204 after publishing `state.reset` on `crew:state`, so
`CENTRIFUGO_API_URL` and `CENTRIFUGO_API_KEY` (or `CENTRIFUGO_HTTP_API_KEY`)
must be configured. Publication failures are surfaced as HTTP errors.

`BudgetModule` exports the single `BudgetStore`. Runtime consumers must use
`store.state` (a Mozaik `RuntimeState`) rather than construct a second state;
reset preserves that object's identity and its participant registry.
`snapshot()` returns an isolated copy; the store retains at most 200 requests.
Contracts and strict agent-output JSON schemas are exported by
`@budget-crew/shared`. Stream positions are intentionally not included yet.
