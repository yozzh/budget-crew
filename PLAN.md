# Daily Budget Crew — hackathon plan

Black Friday AI Hackathon (JigJoy), track "AI agents in finance and fintech". Solo.
Submission deadline: 2026-11-27 24:00 CET. Demos: 2026-11-27 17:00–19:00 CET.

## Hard rules (from build.jigjoy.ai/rules)
- Must use `@mozaik-ai/core` and run **2+ concurrent agents**. Judged mainly on genuine concurrency, then execution, creativity, clarity.
- Synthetic or public data only. No real customer data, accounts or money movement.
- Substance must be built during the event. `reference/daily-projection.ts` is the author's earlier algorithm, kept for reference only: the budget math is rewritten in `packages/budget`, nothing imports from `reference/`. The README says so.
- Submission: repo, description, explanation of how agents run concurrently. Demo video + live deployment strongly recommended.

## Product
Daily budget: a salary opens a period; money left after planned articles is split per day; each actual expense or extra income redistributes the difference over the remaining days. A crew of agents reacts to events around the shared budget state. The user types "salary 2500", "coffee 3.50" or asks "can I buy AirPods for 180?".

| Event | Agents (concurrent) | Scope |
|---|---|---|
| Salary → new period | Planner, Obligations | MVP |
| New expense | Parser → Ledger → Pace, Anomaly, Coach | MVP |
| Extra income | Parser → Ledger → Pace, Coach | MVP |
| "Can I buy X for Y?" | Impact, Obligations, Deal Check, Alternatives → Judge | MVP |
| Month timelapse | Simulator replays a synthetic month, Black Friday as climax | MVP (demo) |
| 3D room | low-poly characters driven by the agent activity stream | after MVP |
| Morning digest, Goals, Telegram | — | not planned |

Architecture, events, state, contracts and modules: `docs/architecture.md`.

## Stack
Node 24, TypeScript, pnpm workspace. NestJS 11 API hosting the Mozaik runtime (`@mozaik-ai/core@6.0.0`); Centrifugo v6.9.1 for realtime; Vite + React 19 web, react-three-fiber for the 3D room. State in memory, seeded from synthetic JSON. Models: `gpt-6.2-sol` (Judge, Coach), `gpt-6.1-terra` (routine agents), `gpt-6-luna` (Parser).

## Delivery
- Repository: GitHub `yozzh/budget-crew` (public). `develop` is protected, requires the `check` workflow; PRs auto-merge when it is green. `main` is the submission branch.
- Stand: https://budget-tracker.internal, redeployed from `develop` within about two minutes after a merge.
- Development: Multica squad Crew (lead + developer) works issues from the backlog; the owner watches the stand.

## Verified on 2026-11-26
- `@mozaik-ai/core` 6.0.0 is final; `@jigjoy/*` are its unstable successors.
- `gpt-6.2-sol` and `gpt-6.1-terra` are not in core's model list: registered with our own specification; all three models return strict JSON schema output.
- Custom event types work through `sendEvent`; three loops started by one event begin within 4 ms and run concurrently.
- Mozaik cloud receives loop events on 6.0.0 with a project key; each `runLoop` is its own cloud session, so the shared picture is our UI.

## Timeline
Thu 26.11 — plan, squad, architecture, CI and stand (done by 11:00); MVP issues; squad builds budget math, contracts, runtime, expense flow.
Fri 27.11 — income/period and purchase flows, 2D UI, timelapse by noon; 3D room if time; 15:00–17:00 deploy check and demo rehearsal; 17:00–19:00 demo; 19:00–23:00 video, README, submit.

## Risks
- Shared Multica runner: other squads can delay Crew issues.
- Races writing shared state from parallel loops → Ledger is the single writer.
- UI runs late → demo on the activity feed + Mozaik cloud timeline.
