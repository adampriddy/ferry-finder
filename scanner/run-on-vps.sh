#!/usr/bin/env bash
# Fallback if Brittany Ferries blocks GitHub's servers: run the same scan from your VPS.
# Needs: git, python3 + requests, node 18+, and a deploy key or token that can push to the repo.
# Cron example (daily 04:20):  20 4 * * *  /home/adam/ferry-finder/scanner/run-on-vps.sh >> /home/adam/ferry-scan.log 2>&1
# Put alert secrets in scanner/.env (NTFY_TOPIC=..., RESEND_API_KEY=..., ALERT_EMAIL=..., SITE_URL=...).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f scanner/.env ] && set -a && . scanner/.env && set +a
git pull --rebase --quiet
cp site/data/latest.json /tmp/ferry-prev.json 2>/dev/null || true
python3 scanner/scan.py
node scanner/alerts.js /tmp/ferry-prev.json site/data/latest.json
git add site/data
git diff --cached --quiet || git commit -qm "Fares $(date -u +%F)"
git push --quiet
