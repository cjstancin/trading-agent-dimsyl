# Learnings Log — Bull (paper)
# One lesson per run, honest, no cheerleading. Append only.

| Date | Lesson |
|------|--------|
| 2026-06-19 | **Check the exchange calendar first.** June 19 is Juneteenth — NYSE/Nasdaq closed. Always verify market hours before queuing orders; wasted cycle otherwise. |
| 2026-06-19 | **Log infra blockers clearly.** Alpaca API blocked by egress policy in scheduled cloud environment. Research and planning can proceed, but execution is impossible until the host is allowlisted. Silence on a blocker is worse than a clear error note. |
| 2026-06-19 | **Hawkish Fed ≠ thesis break.** A hawkish dot plot (77% rate hike probability by Dec 2026) is a headwind, not a fundamental reason to abandon AI secular growth names. The right response is to SIZE DOWN (NEUTRAL regime trim) and be patient — not to panic out of conviction. |
| 2026-06-19 | **CLAUDE.md beats strategy.md on conflicts.** Active profile excludes leveraged ETFs and crypto even though strategy.md mentions TQQQ/SOXL. Hard rulebook wins. Always check CLAUDE.md first when uncertain. |
| 2026-06-19 | **URL construction matters.** ALPACA_BASE_URL already ends in /v2. Adding /v2/account creates a /v2/v2/account double-path. Use $ALPACA_BASE_URL/account (not /v2/account) for all Alpaca REST calls. |
