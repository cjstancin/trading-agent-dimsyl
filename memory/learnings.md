# Learnings — Bull (paper)
# One honest lesson per run, dated. No cheerleading. These compound over time.

---

## 2026-06-19

**Lesson 1 — Egress network policy blocks trading APIs.**
Cloud run environments have outbound network restrictions. `paper-api.alpaca.markets` returned HTTP 403 "Host not in allowlist" — ALL Alpaca REST calls failed silently at first (empty 403 response body), then revealed the egress policy on verbose inspection. Always test API connectivity at the START of a run before spending time on research. If blocked → switch to research-only + staged-order mode immediately, don't keep retrying. Required fix: CJ must add `paper-api.alpaca.markets` and `data.alpaca.markets` to the egress allowlist in Claude Code on the web settings.

**Lesson 2 — Check the market calendar before any action.**
June 19 = Juneteenth. US equity markets (NYSE, Nasdaq) closed. Even if the Alpaca API were accessible, no intraday orders would fill. A simple date/holiday check at run start would have saved time and set the right expectations. Build this into the run loop: if market is closed → research + stage only, no order placement.

**Lesson 3 — NEUTRAL regime signals real caution, not just a 25% size trim.**
VIX 16.41 with a freshly hawkish Fed (potential 2026 hikes) is a legitimate shift. The market's dip-buy after FOMC might not hold if the next inflation print disappoints. In NEUTRAL, prefer sector leaders with specific near-term catalysts (NVDA's RTX Spark, SMH's sector leadership) over broad index plays or extended momentum names (AMD +130% YTD without H2 catalyst). Concentration in quality + specificity of catalyst = NEUTRAL-regime alpha.

---
