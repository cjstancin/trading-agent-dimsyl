# Learnings — Bull (paper)
# One honest lesson per entry. Dated. No cheerleading.

---

## 2026-06-19
- **Network egress blocks Alpaca API in this remote environment.** The scheduled run cannot
  place or read orders from `paper-api.alpaca.markets` — the host is not in the allowlist.
  Lesson: the daily run must document INTENDED trades clearly so CJ or a reconnected run can
  execute them. Never assume network access. Consider adding a connectivity check at run start
  and failing fast with a Discord alert rather than running a full cycle with no execution path.

- **Start with the most liquid breakout, not the broadest exposure.** On a NEUTRAL regime day
  with hawkish Fed news, the instinct to add 2 positions (ARM + ANET) is correct only if
  they're genuinely uncorrelated. ARM (chip design) and ANET (networking) share the "AI infra"
  theme — in a risk-off shock they'd both sell off together. Track this: if both drop >5% on
  the same day for macro reasons, the correlation is real and sizing should be reduced further.
