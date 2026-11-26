# Daily Budget Crew

Hackathon project (JigJoy Black Friday, deadline 2026-11-27 24:00 CET). Product, rules and timeline: `PLAN.md`.

## Rules

- `@mozaik-ai/core` stays at 6.0.0; the rules require 2+ agents running concurrently.
- Inside Mozaik processors never `await` `runLoop` or `sendMessage`.
- Budget math is deterministic, lives in code with tests; agents call it as a tool, never compute money themselves.
- Synthetic data only. No real personal finance data, no secrets in Git.
- `reference/` is read-only material from an earlier project: never import from it.
- Never call a real LLM, OpenAI or Mozaik cloud from tests or CI: `INFERENCE=stub`.

## Layout

| Path | What |
|---|---|
| `apps/api` | NestJS 11 (ESM): HTTP under `/api`, serves the built web app |
| `apps/web` | Vite + React 19 |
| `packages/shared` | zod contracts shared by API and web |
| `deploy/` | stand: `compose.yaml`, `centrifugo/config.json`, `stand/update.sh` |

## Checks

Node 24, pnpm 12.15 (`packageManager` in `package.json`). From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The GitHub workflow `check` runs exactly these on every PR; `develop` requires it green.
Run locally: `pnpm build && PORT=3000 node apps/api/dist/main.js`, then `GET /api/health`.
Web dev server: `pnpm --filter @budget-crew/web dev` (proxies `/api` to `127.0.0.1:3000`).

## Branches and stand

- Work in a branch from `develop`, PR into `develop`; GitHub merges on green `check`.
- `main` is the submission branch, updated by the owner.
- Every merge into `develop` redeploys https://budget-tracker.internal within about two minutes (`deploy/stand/update.sh`, host timer). The stand runs `deploy/compose.yaml`: app on port 3000, Centrifugo v6.9.1 under `/connection`.
- Environment: `.env.example` lists every variable.
