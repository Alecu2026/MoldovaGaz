#!/usr/bin/env bash
# Verifică GitHub-ul și face deploy doar dacă există commit-uri noi pe branch-ul curent.
# Rulează singur din pm2 (aplicația „<nume>-autodeploy”, vezi ecosystem.config.js), o dată pe minut; poate fi pornit și din cron.
set -euo pipefail
cd "$(dirname "$0")/.."
git fetch --quiet origin
branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$branch")" ]; then exit 0; fi
echo "[$(date -Is)] commit nou pe $branch → deploy"
./deploy/deploy.sh
