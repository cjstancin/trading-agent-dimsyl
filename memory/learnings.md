# Learnings — Bull (paper)
# One honest lesson per run, dated. No cheerleading.

---

## 2026-06-19
**Lesson:** The cloud execution environment's network egress policy blocked both `paper-api.alpaca.markets` and `finnhub.io`, making live account sync and market data unavailable. A trading agent that can't reach its broker cannot execute — this is the #1 infrastructure dependency to lock down. Fix: add both hosts to egress allowlist before next run. Secondary: Juneteenth (June 19) is a US market holiday; built-in market-calendar check in `scripts/` should flag this so no order placement is attempted even if Alpaca were reachable.

**Also noted:** Approaching AVGO when it's breaking support ($410) is risky even if the fundamental thesis is intact. "Catching a falling knife" without seeing Monday's stabilization would violate the oversold-snapback criterion (requires "turning up off support," not still falling). Patience is correct here — wait for Monday's price action.
