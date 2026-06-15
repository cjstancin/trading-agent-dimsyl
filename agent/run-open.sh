#!/usr/bin/env bash
# Bill the Bull — MARKET OPEN (Mon-Fri 9:30 ET via systemd timer bill-open.timer).
# Sequence: (1) morning brief → #trade-bot, (2) scan for setups, (3) execute per MODE
# (gated = proposes; auto = places paper orders under guardrails).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs
LOG=logs/open.log
echo "---- $(date -Is) MARKET OPEN ----" >> "$LOG"
npm run premarket >> "$LOG" 2>&1 || true
npm run scan      >> "$LOG" 2>&1 || true
npm run execute   >> "$LOG" 2>&1 || true
