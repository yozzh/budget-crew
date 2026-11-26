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

## Prior work

`reference/daily-projection.ts` is the author's earlier daily-budget algorithm, kept for reference only. The budget math in this repository is rewritten during the event and does not import it.
