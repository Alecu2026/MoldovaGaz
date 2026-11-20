#!/usr/bin/env bash
# Verifică GitHub-ul și face deploy doar dacă există commit-uri noi pe branch-ul curent. Pentru cron (fără secrete în GitHub, fără porturi deschise):
#   crontab -e   →   * * * * * /calea/catre/MoldovaGaz/deploy/auto-deploy.sh >> /calea/catre/MoldovaGaz/logs/auto-deploy.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
git fetch --quiet origin
branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$branch")" ]; then exit 0; fi
echo "[$(date -Is)] commit nou pe $branch → deploy"
./deploy/deploy.sh
