#!/usr/bin/env bash
# Deploy pe server, din repo-ul clonat:   ./deploy/deploy.sh      (îl pornește și deploy/auto-deploy.sh la fiecare commit nou)
#  - un singur deploy odată (lock): push-uri rapide una după alta nu se calcă;
#  - `npm ci` doar dacă s-au schimbat dependențele (sau lipsește node_modules);
#  - dacă build-ul noului commit pică, revine automat la commit-ul anterior și aplicația rămâne pe versiunea care mergea.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env.local ] || { echo "Lipsește .env.local — copiază .env.example și completează DATABASE_URL și INGEST_TOKEN."; exit 1; }
grep -Eq '^INGEST_TOKEN="?[^" ]+' .env.local || { echo "INGEST_TOKEN e gol în .env.local."; exit 1; }
command -v pm2 >/dev/null || { echo "pm2 nu e instalat:  npm i -g pm2"; exit 1; }

env_get() { grep -E "^$1=" .env.local | tail -1 | cut -d= -f2- | tr -d '"' | tr -d '\r' || true; }
NAME=$(env_get PM2_NAME); NAME=${NAME:-moldovagaz}
PORT_NOW=$(env_get PORT); PORT_NOW=${PORT_NOW:-3000}

exec 9>/tmp/"$NAME"-deploy.lock
flock -n 9 || { echo "Alt deploy rulează deja."; exit 0; }

# pornește / reîncarcă DOAR aplicația (nu și watcher-ul care a pornit acest script)
start_or_reload() {
  mkdir -p logs
  pm2 startOrReload ecosystem.config.js --only "$NAME" --update-env
  pm2 save >/dev/null
}

install_and_build() {
  if [ ! -d node_modules ] || [ "${1:-}" = "force" ]; then npm ci; fi
  npm run build
}

PREV=$(git rev-parse HEAD)
echo "[$(date -Is)] git pull (acum: ${PREV:0:7})"
git pull --ff-only
NEW=$(git rev-parse HEAD)

NEED_CI=""
if [ "$PREV" != "$NEW" ] && git diff --name-only "$PREV" "$NEW" | grep -Eq '^package(-lock)?\.json$'; then NEED_CI=force; fi

if ! install_and_build "$NEED_CI"; then
  echo "!! Build eșuat pe ${NEW:0:7} — revin la ${PREV:0:7}"
  git reset --hard "$PREV"
  install_and_build force
  start_or_reload
  exit 1
fi

echo "pm2 reload (${NEW:0:7})"
start_or_reload
echo "Gata (${NEW:0:7}). Verifică:  pm2 status  |  pm2 logs $NAME  |  curl -I http://localhost:$PORT_NOW/login"
