#!/usr/bin/env bash
# Install/refresh Bill's systemd units from the repo — infra-as-code, idempotent.
# Run on the VPS as root, from anywhere:  sudo /home/cj/bull/agent/systemd/install.sh
# (Committed 2026-07-19 verbatim from the live /etc/systemd/system units. INFRA ONLY —
# schedules/entrypoints unchanged; trade/money logic is out of scope for this dir entirely.
# bill-revalidate.{service,timer} stays a TEMPLATE — it is NOT live on the box, so this
# installer deliberately does not install or enable it; activating it is a separate CJ call.)
set -euo pipefail
cd "$(dirname "$0")"

install -m 644 \
  bill-open.service bill-open.timer \
  bill-mid.service bill-mid.timer \
  bill-close.service bill-close.timer \
  bill-brief.service bill-brief.timer \
  bill-heartbeat.service bill-heartbeat.timer \
  bill-realloc.service bill-realloc.timer \
  bill-refresh.service bill-refresh.timer \
  /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now bill-open.timer bill-mid.timer bill-close.timer bill-brief.timer \
  bill-heartbeat.timer bill-realloc.timer bill-refresh.timer
systemctl list-timers 'bill-*' --no-pager | head -10
