#!/usr/bin/env bash
# Bill the Bull — THESIS RE-VALIDATION (Mon-Fri ~13:45 ET via bill-revalidate.timer, once mid-session).
# For each OPEN position: re-check the ORIGINAL entry thesis against fresh news/price/regime and verdict it
# valid / weakening / broken with a suggested hold / trim / exit. Propose-only in gated mode; in auto
# (+ BILL_ALLOW_AUTO_EXEC=1) the validated, deterministically-sized sells are placed. Nothing in off.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs
LOG=logs/revalidate.log
echo "---- $(date -Is) THESIS RE-VALIDATION ----" >> "$LOG"
npm run revalidate >> "$LOG" 2>&1 || true
