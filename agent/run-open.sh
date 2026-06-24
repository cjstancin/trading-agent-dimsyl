#!/usr/bin/env bash
# Bill the Bull — MARKET OPEN (Mon-Fri 9:30 ET via bill-open.timer).
# The brief + scan + plan already ran at 9:15 (bill-brief.timer), so the open run just SIZES + FIRES
# the pre-computed orders (Signals/planned-orders.json) — skipping the slow LLM call, so buys hit within
# seconds of the bell. `execute --from-plan` sizes each order on the LIVE open price and enforces the
# risk halt + guardrails before placing; if the plan is missing/stale it proposes live as a fallback.
# Belt-and-suspenders: if today's approved cycle is missing/stale (the 9:15 run failed), re-scan first
# so the fallback proposal has a fresh cycle to read.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs
LOG=logs/open.log
echo "---- $(date -Is) MARKET OPEN (execute --from-plan) ----" >> "$LOG"
CYCLE=../Signals/approved-cycle.md
if [ ! -f "$CYCLE" ] || [ "$(date -u +%Y-%m-%d)" != "$(date -u -r "$CYCLE" +%Y-%m-%d 2>/dev/null)" ]; then
  echo "[open] approved-cycle.md missing/stale (9:15 scan didn't land today) → re-scan first" >> "$LOG"
  npm run scan >> "$LOG" 2>&1 || true
fi
npm run execute:open >> "$LOG" 2>&1 || true
