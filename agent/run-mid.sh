#!/usr/bin/env bash
# Bill the Bull — MID-DAY trade cycle (Mon-Fri 12:30 ET via bill-mid.timer).
# Re-scan for fresh setups + execute per MODE. No reports — open + close handle those.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs
LOG=logs/mid.log
echo "---- $(date -Is) MID-DAY ----" >> "$LOG"
npm run scan    >> "$LOG" 2>&1 || true
npm run execute >> "$LOG" 2>&1 || true
