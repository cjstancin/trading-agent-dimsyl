#!/usr/bin/env bash
# Bill v2 — weekly ritual (see systemd/v2/bill2-weekly.timer for the schedule).
# Thin wrapper: the ritual itself owns market-day gates, mode gates, and error notes — this only
# provides cwd, logging, and a non-zero-exit shield (a ritual failure must not flap the timer unit).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs
LOG=logs/v2-weekly.log
echo "---- $(date -Is) v2 weekly ----" >> "$LOG"
npm run v2:weekly >> "$LOG" 2>&1 || true
