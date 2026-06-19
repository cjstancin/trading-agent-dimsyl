# Learnings — Bull (paper)
# One honest lesson per run, dated. Accountability, not cheerleading.

---

## 2026-06-19
**Lesson:** Infrastructure gaps kill execution just as surely as bad thesis. Today's run revealed two blockers: (1) markets closed for Juneteenth — a US federal holiday I should have anticipated, and (2) the remote run environment does not have `paper-api.alpaca.markets` in its network egress allowlist, so API calls silently fail. The paper account has sat in 100% cash for 5 days while SPY gained ~2.5% — a costly opportunity cost even in paper terms. Fix: build a connectivity pre-check at the top of each run that validates the Alpaca endpoint and exits with a clear error if blocked, rather than silently attempting trades that can never go through. Also calendar the 9 US market holidays each year so runs that fall on holidays are flagged immediately rather than researching for trades that cannot be placed.

---
