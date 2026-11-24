#!/usr/bin/env bash
# Verifică GitHub-ul și face deploy doar dacă există commit-uri noi pe branch-ul curent (sau dacă build-ul curent lipsește / a rămas neterminat).
# Rulează singur din pm2 (aplicația „<nume>-autodeploy”, vezi ecosystem.config.js), o dată pe minut; poate fi pornit și din cron.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs
git fetch --quiet origin
branch=$(git rev-parse --abbrev-ref HEAD)
# un deploy rulează deja (pornit mai devreme, detașat de pm2): nu pornim altul
if pgrep -f "deploy/deploy.sh" >/dev/null 2>&1; then exit 0; fi
if [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$branch")" ]; then
  # la zi; singurul caz în care mai facem ceva: build-ul lipsește sau a rămas neterminat (un deploy întrerupt lasă .next fără BUILD_ID, iar aplicația dă ChunkLoadError)
  [ -f .next/BUILD_ID ] && exit 0
  # ...dar cel mult o încercare la 10 minute, ca un build care nu reușește să nu se repete în fiecare minut
  [ -n "$(find logs/.heal -mmin -10 2>/dev/null)" ] && exit 0
  touch logs/.heal
  echo "[$(date -Is)] build lipsă sau neterminat (.next/BUILD_ID) → deploy"
else
  echo "[$(date -Is)] commit nou pe $branch → deploy"
fi
# Deploy-ul rulează DETAȘAT de pm2 (sesiune proprie): pm2 repornește acest script în fiecare minut (cron_restart) și ar omorî un build care durează
# mai mult de un minut — `.next` rămânea pe jumătate scris, iar aplicația pornită dădea ChunkLoadError («Consum nemăsurat», «Rapoarte», «Facturare» nu se încărcau).
# Suprapunerea e oprită de flock din deploy.sh. Explicit cu bash: nu depinde de bitul de execuție.
setsid nohup bash ./deploy/deploy.sh >> logs/auto-deploy.log 2>&1 < /dev/null &
exit 0
