# Daily Budget Crew — hackathon plan

Black Friday AI Hackathon (JigJoy), track "AI agents in finance and fintech". Solo.
Submission deadline: 2026-11-27 24:00 CET. Demos: 2026-11-27 17:00–19:00 CET.

## Hard rules (from build.jigjoy.ai/rules)
- Must use `@mozaik-ai/core` and run **2+ concurrent agents**. Judged mainly on genuine concurrency, then execution, creativity, clarity.
- Synthetic or public data only. No real customer data, accounts or money movement.
- Substance must be built during the event. `reference/daily-projection.ts` is the author's earlier algorithm, kept for reference only: rewrite it in `src/`, do not import from `reference/`. Mention this in the README.
- Submission: repo, description, explanation of how agents run concurrently. Demo video + live deployment strongly recommended.

## Product
Daily budget: period money left after planned articles is split per day; each actual expense redistributes the difference to the remaining days (see reference algorithm). A crew of agents reacts to events around the shared budget state. The user only types "coffee 350" or asks "can I buy X for Y?".

| Event | Agents (concurrent) | Scope |
|---|---|---|
| New expense (free text) | Parser publishes `expense.parsed` → Pace, Anomaly, Coach react in parallel | MVP |
| "Can I buy X for Y?" | Budget Impact, Obligations, Deal Check, Alternatives → Judge | MVP |
| Month timelapse | Simulator replays a synthetic month, Black Friday as climax | MVP (demo) |
| Morning | Digest, Obligations | nice-to-have |
| Period start / income | Planner, Goals | nice-to-have |
| Telegram UI | same runtime, another Human participant | nice-to-have |

## Architecture
- One Mozaik runtime. `BudgetState extends RuntimeState`: period, articles, expenses, projection, `verdicts[requestId][agentName]`, feed.
- No orchestrator: each agent has a `SituationSpecification` for the events it cares about and calls `runLoop` (fire-and-forget, never awaited inside processors).
- Budget math is a pure deterministic function exposed to agents as a tool (`simulateBudget(purchase)`); LLMs interpret, never compute.
- Every agent uses `structuredOutput` so the UI renders verdict cards.
- Each agent writes only its own slot in shared state (avoid races). Judge reacts when all verdicts for a request are present.
- Participants: Human (web UI), Simulator, UI Observer (events → SSE), agents above.
- Mozaik cloud (`npx @mozaik-ai/cloud-sdk pair`) shows the loop timeline — use it in the demo.

## Stack
Node 24 + TypeScript, `@mozaik-ai/core@6.0.0`, Hono or Fastify + SSE, Vite + React single page. In-memory state + JSON seed of a synthetic user. Deploy with Docker on hetzner-workstation.

## First checks (before writing product code)
1. `@mozaik-ai/core` 6.0.0 is the final version; `@jigjoy/*` packages are the unstable successors — stay on core 6.0.0 (the rules require it).
2. Out of the box inference is OpenAI (`OPENAI_API_KEY`). `../mozaik-examples/custom-inference-runner` shows how to plug another provider — use it if we go with Claude.
3. Dashboard says cloud events flow automatically "on core 4.x" — verify they also flow on 6.0.0.
4. Find out whether custom event types can be published, or must be encoded via `message.sent` payloads.
5. Read examples: `structured-output`, `tool-calling`, `shared-state`, `history-simulation` (multi-agent + observer).

## Timeline
Thu 26.11
- before 10:00 — env, LLM key, run one example, cloud pair → example visible in Mozaik cloud
- 10:00–10:30 — kickoff, read brief, adjust plan
- 10:30–12:30 — skeleton: runtime, BudgetState, projection + tests, synthetic seed → CLI "expense → new daily budget"
- 12:30–15:30 — Parser + Pace/Anomaly/Coach → 3 concurrent loops visible in cloud
- 15:30–18:00 — "can I buy": 4 agents + Judge → verdict with numbers in console
- 18:00–21:00 — HTTP + SSE + minimal UI
- evening — commit, draft README, first deploy

Fri 27.11
- morning — timelapse simulator
- 11:00–15:00 — polish UI and chart, edge cases, nice-to-haves if time
- 15:00–17:00 — deploy, rehearse demo
- 17:00–19:00 — demo session
- 19:00–23:00 — 2–3 min video, README (how to run, where concurrency is), submit by 23:00

## Risks
- No suitable LLM key / provider → decide before kickoff; cheap model for Parser/Coach.
- Brief narrows the topic → core (budget + event-reacting agents) survives a scenario change.
- Races writing shared state from parallel loops → per-agent slots.
- UI runs late → demo on CLI + Mozaik cloud timeline.
