---
type: "memory"
file: "learnings"
---

# Learnings — Bull (paper)
# Dated lessons: one line min, honest, no cheerleading. Append only.

---

## 2026-06-19 — First daily run; network egress blocks Alpaca + Finnhub

**Lesson:** The cloud execution environment's network egress policy does NOT include `paper-api.alpaca.markets` or `finnhub.io` in its allowlist. This means the agent can research via web search but cannot execute trades or pull live market data via API. **Action required by CJ: add both hosts to the network egress allowlist** (see https://code.claude.com/docs/en/claude-code-on-the-web). Until then, every run will produce a research + staged trade plan but no actual Alpaca execution.

**Lesson:** Juneteenth (June 19) is a US market holiday — NYSE/NASDAQ closed. The agent should check the NYSE holiday calendar before expecting executions and should note the next trading day.

**Lesson:** The `caps` fields in `dashboard/data/status.json` reflected the OLD aggressive profile (10% risk, 40% max position, 10% daily halt, 30% monthly kill) but CLAUDE.md's June 14 "reigned in" profile lowered them (7% risk, 30% max, 8% daily halt, 25% monthly kill). Mismatches between config files and memory files must be resolved in favor of CLAUDE.md. Updated `status.json` caps accordingly.

**Lesson:** All-cash while the market runs is a cost. The paper account is down ~3.9% vs SPY since inception (SPY is up ~3.9% since June 14 while we've been all-cash). The sooner network access is restored and trades are executed, the sooner we can start generating alpha vs. SPY. Sitting on cash is a choice with a known opportunity cost.

**Lesson:** In NEUTRAL regime (VIX 16–24), CLAUDE.md says "trim new sizes ~25%; be choosier." Applied: $7K risk budget × 0.75 = $5,250 effective risk per trade. This resulted in 124 NVDA shares and 64 AVGO shares — more conservative sizing than pure formula.

**Lesson:** AMD trading near ATH after a 19% monthly surge, while CJ has substantial real-money AMD exposure, makes it a low-priority paper trade in NEUTRAL regime. Concentration of thesis AND portfolio alignment counsels watching for a dip rather than chasing.
