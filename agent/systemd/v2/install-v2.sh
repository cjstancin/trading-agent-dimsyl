#!/usr/bin/env bash
# Install Bill v2 units — DISABLED by design. The one-launch-day rule (design §11): CJ flips them
# with `systemctl enable --now bill2-*.timer bill2-console.service` when validation is green and
# the fresh paper account keys are in /home/cj/bull/agent/.env. Old bill-* v1 timers stay disabled.
# Run on the VPS as root:  sudo /home/cj/bull/agent/systemd/v2/install-v2.sh
set -euo pipefail
cd "$(dirname "$0")"
install -m 644 \
  bill2-morning.service bill2-morning.timer bill2-morning2.timer \
  bill2-insider-poll.service bill2-insider-poll.timer \
  bill2-evening.service bill2-evening.timer \
  bill2-weekly.service bill2-weekly.timer \
  bill2-anchor-filing.service bill2-anchor-filing.timer \
  bill2-statement.service bill2-statement.timer \
  bill2-console.service \
  /etc/systemd/system/
systemctl daemon-reload
echo "Installed (NOT enabled). Launch day: systemctl enable --now bill2-{morning,morning2,insider-poll,evening,weekly,anchor-filing,statement}.timer bill2-console.service"
