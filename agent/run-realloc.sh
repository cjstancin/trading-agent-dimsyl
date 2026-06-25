#!/usr/bin/env bash
# Bill the Bull — INTRADAY ROTATION (Mon-Fri, ~hourly during market hours via bill-realloc.timer).
# Generates fresh candidate ideas, plans swaps (cut the weakest laggard → fund a higher-conviction idea),
# and in auto mode EXECUTES them: sell the laggard (cancels its stop + liquidates) → size + buy the better
# idea with a fresh protective stop. Propose-only in gated mode; nothing in off. The risk halt gates buys.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs
LOG=logs/realloc.log
echo "---- $(date -Is) ROTATION (reallocate --execute) ----" >> "$LOG"
npm run reallocate:auto >> "$LOG" 2>&1 || true
