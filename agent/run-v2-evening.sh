#!/usr/bin/env bash
# Bill v2 — evening ritual (see systemd/v2/bill2-evening.timer for the schedule).
# Thin wrapper: the ritual itself owns market-day gates, mode gates, and error notes — this only
# provides cwd, logging, and a non-zero-exit shield (a ritual failure must not flap the timer unit).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs
LOG=logs/v2-evening.log
echo "---- $(date -Is) v2 evening ----" >> "$LOG"
npm run v2:evening >> "$LOG" 2>&1 || true
