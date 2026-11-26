#!/usr/bin/env bash
# Redeploy https://budget-tracker.internal when origin/develop has a new commit with a green `check`.
# Run by budget-crew-stand-update.timer every minute; `--force` redeploys the current head.
set -euo pipefail

REPO=yozzh/budget-crew
BRANCH=develop
STATE="${STATE_DIR:-$HOME/.local/share/budget-crew-stand}"
ENV_FILE="${ENV_FILE:-$HOME/.config/budget-crew-stand/stand.env}"
SRC="$STATE/source"
HEALTH_URL=https://budget-tracker.internal/api/health
# Everything runs inside main(): bash has parsed the whole file before `git checkout` replaces it.
main() {
mkdir -p "$STATE"
exec 9>"$STATE/.lock"
flock -n 9 || exit 0

log() { printf '%s %s\n' "$(date -Is)" "$*"; }

if [ ! -d "$SRC/.git" ]; then
  git clone -q --branch "$BRANCH" "https://github.com/$REPO.git" "$SRC"
fi
git -C "$SRC" fetch -q origin "$BRANCH"
head=$(git -C "$SRC" rev-parse "origin/$BRANCH")
current=$(cat "$STATE/deployed" 2>/dev/null || true)

if [ "$head" = "$current" ] && [ "${1:-}" != "--force" ]; then
  exit 0
fi

# Deploy only what CI accepted. `check` runs on push to develop; until it is green the timer retries.
conclusion=$(gh api "repos/$REPO/commits/$head/check-runs?check_name=check" --jq '.check_runs[0].conclusion // "pending"' 2>/dev/null || echo unknown)
if [ "$conclusion" != success ] && [ "${1:-}" != "--force" ]; then
  [ "$(cat "$STATE/waiting" 2>/dev/null)" = "$head $conclusion" ] || log "skip ${head:0:12}: check=$conclusion"
  echo "$head $conclusion" > "$STATE/waiting"
  exit 0
fi

log "deploy ${head:0:12} (was ${current:0:12})"
git -C "$SRC" checkout -q --detach "$head"
export APP_VERSION="${head:0:12}"
compose=(docker compose -f "$SRC/deploy/compose.yaml" --env-file "$ENV_FILE")
"${compose[@]}" build -q
"${compose[@]}" up -d --wait --remove-orphans

for _ in $(seq 30); do
  if curl -fsk "$HEALTH_URL" | grep -q "\"version\":\"$APP_VERSION\""; then
    echo "$head" > "$STATE/deployed"
    rm -f "$STATE/waiting"
    docker images budget-crew-app --format '{{.Tag}}' | grep -vx "$APP_VERSION" | xargs -r -I{} docker rmi -f budget-crew-app:{} >/dev/null 2>&1 || true
    log "deployed ${head:0:12}"
    exit 0
  fi
  sleep 2
done
log "health check failed for ${head:0:12}"
exit 1
}

main "$@"
