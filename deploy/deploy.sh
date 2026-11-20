#!/usr/bin/env bash
# Deploy pe server, din repo-ul clonat:   ./deploy/deploy.sh
# Prima dată pe server:  git clone … && cd MoldovaGaz && cp .env.example .env.local && nano .env.local && ./deploy/deploy.sh
#  - un singur deploy odată (lock): push-uri rapide una după alta nu se calcă;
#  - dacă build-ul noului commit pică, se revine automat la commit-ul anterior și aplicația rămâne pe versiunea care mergea.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env.local ] || { echo "Lipsește .env.local — copiază .env.example și completează DATABASE_URL și INGEST_TOKEN."; exit 1; }
grep -Eq '^INGEST_TOKEN="?[^" ]+' .env.local || { echo "INGEST_TOKEN e gol în .env.local."; exit 1; }
command -v pm2 >/dev/null || { echo "pm2 nu e instalat:  npm i -g pm2"; exit 1; }

exec 9>/tmp/moldovagaz-deploy.lock
flock -n 9 || { echo "Alt deploy rulează deja."; exit 0; }

start_or_reload() {
  mkdir -p logs
  if pm2 describe moldovagaz >/dev/null 2>&1; then
    pm2 reload ecosystem.config.cjs --update-env
  else
    pm2 start ecosystem.config.cjs
  fi
  pm2 save >/dev/null
}

PREV=$(git rev-parse HEAD)
echo "→ git pull (acum: ${PREV:0:7})"
git pull --ff-only
NEW=$(git rev-parse HEAD)

echo "→ npm ci (cu devDependencies: build-ul are nevoie de Tailwind / TypeScript)"
if ! { npm ci && npm run build; }; then
  echo "!! Build eșuat pe ${NEW:0:7} — revin la ${PREV:0:7}"
  git reset --hard "$PREV"
  npm ci && npm run build
  start_or_reload
  exit 1
fi

echo "→ pm2 (${NEW:0:7})"
start_or_reload
echo "Gata (${NEW:0:7}). Verifică:  pm2 status  |  pm2 logs moldovagaz  |  curl -I http://localhost:\${PORT:-3000}/login"
