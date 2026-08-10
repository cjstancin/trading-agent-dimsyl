#!/usr/bin/env bash
# Bill v2 — statement ritual (see systemd/v2/bill2-statement.timer for the schedule).
# Thin wrapper: the ritual itself owns market-day gates, mode gates, and error notes — this only
# provides cwd, logging, and a non-zero-exit shield (a ritual failure must not flap the timer unit).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs
LOG=logs/v2-statement.log
echo "---- $(date -Is) v2 statement ----" >> "$LOG"
npm run v2:statement >> "$LOG" 2>&1 || true
