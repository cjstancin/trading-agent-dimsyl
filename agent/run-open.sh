#!/usr/bin/env bash
# Bill the Bull — MARKET OPEN (Mon-Fri 9:30 ET via bill-open.timer).
# The pre-market brief + scan already ran at 9:15 (bill-brief.timer), so the open run just
# EXECUTES the pre-computed APPROVED CYCLE — orders hit within seconds of the open instead of
# waiting on the brief + scan. Fallback: if today's approved cycle is missing or stale (the
# 9:15 run failed), re-scan first so we never execute on a stale / absent list.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs
LOG=logs/open.log
echo "---- $(date -Is) MARKET OPEN (execute) ----" >> "$LOG"
CYCLE=../Signals/approved-cycle.md
if [ ! -f "$CYCLE" ] || [ "$(date -u +%Y-%m-%d)" != "$(date -u -r "$CYCLE" +%Y-%m-%d 2>/dev/null)" ]; then
  echo "[open] approved-cycle.md missing/stale (9:15 scan didn't land today) → re-scan first" >> "$LOG"
  npm run scan >> "$LOG" 2>&1 || true
fi
npm run execute >> "$LOG" 2>&1 || true
