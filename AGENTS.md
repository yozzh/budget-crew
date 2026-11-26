# Working rules

- Read `PLAN.md` first; it holds the hackathon rules, architecture and timeline.
- `reference/` is read-only reference material from a pre-hackathon project. Never import from it; rewrite what is needed in `src/`.
- Synthetic data only. Never copy real personal finance data into this repo.
- Mozaik examples live in `../mozaik-examples` — check them before guessing an API.
- Inside Mozaik processors never `await` `runLoop` or `sendMessage`.
- Keep budget math deterministic and tested; agents call it as a tool.
- Commit small and often; the repo must stay runnable for judges (`npm install && npm start` plus a `.env.example`).
