#!/usr/bin/env bash
# Deploy pe server, din repo-ul clonat:   ./deploy/deploy.sh
# Prima dată pe server:  git clone … && cd MoldovaGaz && cp .env.example .env.local && nano .env.local && ./deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env.local ] || { echo "Lipsește .env.local — copiază .env.example și completează DATABASE_URL și INGEST_TOKEN."; exit 1; }
grep -Eq '^INGEST_TOKEN="?[^" ]+' .env.local || { echo "INGEST_TOKEN e gol în .env.local."; exit 1; }
command -v pm2 >/dev/null || { echo "pm2 nu e instalat:  npm i -g pm2"; exit 1; }

echo "→ git pull"
git pull --ff-only

echo "→ npm ci (cu devDependencies: build-ul are nevoie de Tailwind / TypeScript)"
npm ci

echo "→ build"
npm run build

mkdir -p logs
echo "→ pm2"
if pm2 describe moldovagaz >/dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs --update-env
else
  pm2 start ecosystem.config.cjs
fi
pm2 save

echo "Gata. Verifică:  pm2 status  |  pm2 logs moldovagaz  |  curl -I http://localhost:\${PORT:-3000}/login"
