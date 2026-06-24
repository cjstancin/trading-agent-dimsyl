#!/usr/bin/env bash
# Bill the Bull — PRE-MARKET BRIEF + SCAN (Mon-Fri 9:15 ET via bill-brief.timer).
# Runs the read-only analysis ~15 min before the open: (1) posts the pre-market brief to #trade-bot,
# (2) scans for setups and writes today's APPROVED CYCLE (Signals/approved-cycle.md), (3) PRE-COMPUTES
# the concrete orders (the LLM propose step → Signals/planned-orders.json). Places NO orders. Moving the
# slow LLM call here means the 9:30 open run just sizes + fires the pre-computed plan — orders hit within
# seconds of the bell instead of ~9:40.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs
LOG=logs/brief.log
echo "---- $(date -Is) PRE-MARKET BRIEF + SCAN + PLAN ----" >> "$LOG"
npm run premarket >> "$LOG" 2>&1 || true
npm run scan      >> "$LOG" 2>&1 || true
npm run plan      >> "$LOG" 2>&1 || true   # LLM propose → planned-orders.json (no placement)
