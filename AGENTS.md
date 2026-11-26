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
Run locally: `docker compose up --build -d --wait` (root `compose.yaml`: app, Centrifugo and a proxy on http://localhost:3000), or `node scripts/install.mjs` (wizard). Keep the README quick start working from a fresh clone.
Without Docker for the app: `pnpm build && pnpm start` (reads `.env`), then `GET /api/health`.
Web dev server: `pnpm dev` (proxies `/api` to `PORT`, `/connection` to `CENTRIFUGO_PORT`).

## Branches and stand

- Work in a branch from `develop`, PR into `develop`; GitHub merges on green `check`.
- `main` is the submission branch, updated by the owner.
- Every merge into `develop` redeploys https://budget-tracker.internal within about two minutes (`deploy/stand/update.sh`, host timer). The stand runs `deploy/compose.yaml`: app on port 3000, Centrifugo v6.9.1 under `/connection`.
- Environment: `.env.example` lists every local variable; the stand reads `deploy/compose.yaml` variables from `~/.config/budget-crew-stand/stand.env`.
