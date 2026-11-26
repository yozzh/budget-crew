# Public demo

https://budget-crew.smirnoff.pro runs `deploy/public/compose.yaml` on a small VPS: the app, Centrifugo and Caddy with an automatic Let's Encrypt certificate.

Requirements: Docker with Compose v2, ports 80 and 443 open, and a DNS `A` record for the domain pointing at the server.

```sh
git clone https://github.com/yozzh/budget-crew.git && cd budget-crew
cp deploy/public/.env.example deploy/public/.env && chmod 600 deploy/public/.env
# fill OPENAI_API_KEY and CENTRIFUGO_API_KEY
APP_VERSION=$(git rev-parse --short=12 HEAD) docker compose -f deploy/public/compose.yaml --env-file deploy/public/.env up --build -d --wait
curl https://budget-crew.smirnoff.pro/api/health
```

Update: `git pull`, then the same `up` command. The budget lives in memory and is shared by every visitor; `POST /api/reset` restores the seed.
