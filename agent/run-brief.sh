#!/usr/bin/env bash
# Bill the Bull — PRE-MARKET BRIEF + SCAN (Mon-Fri 9:15 ET via bill-brief.timer).
# Runs the read-only analysis ~15 min before the open: (1) posts the pre-market brief to
# #trade-bot, (2) scans for setups and writes today's APPROVED CYCLE (Signals/approved-cycle.md).
# Places NO orders. Doing the analysis here means the 9:30 open run just EXECUTES the pre-computed
# cycle — orders hit within seconds of the open instead of after a ~10-min brief+scan delay.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs
LOG=logs/brief.log
echo "---- $(date -Is) PRE-MARKET BRIEF + SCAN ----" >> "$LOG"
npm run premarket >> "$LOG" 2>&1 || true
npm run scan      >> "$LOG" 2>&1 || true
