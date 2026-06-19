#!/usr/bin/env bash
# Bill the Bull — MARKET CLOSE (Mon-Fri 16:00 ET via bill-close.timer).
# Sequence: reconcile → refresh scoreboard → journal new closes → EOD report to #trade-bot
# (current state, how the day went, what was bought + sold).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs
LOG=logs/close.log
echo "---- $(date -Is) MARKET CLOSE ----" >> "$LOG"
npm run refresh    >> "$LOG" 2>&1 || true
npm run journal    >> "$LOG" 2>&1 || true
npm run eod-report >> "$LOG" 2>&1 || true
