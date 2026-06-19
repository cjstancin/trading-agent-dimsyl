# Research Log — Bull (paper)
# Dated research notes. Appended each run.

---

## 2026-06-19 — Daily Run (Juneteenth — market closed)

### Market Regime
- **VIX:** ~16.41 as of June 16, 2026 → **NEUTRAL** (16–24 range per strategy.md).
  - Context: VIX peaked at 31.05 in late March, pulled back through April/May, spiked to 22.22 on June 10 (tech profit-taking + Fed meeting), then dropped back to mid-teens.
  - Actionable: Trim new sizes ~25% vs full risk-on; be choosier with entries.
- **SPY:** $746.74 (June 18 close), +10.99% YTD, +1.77% over 30 days. 52-week high: $760.40 (June 2). Currently ~1.8% below 52-week high.
- **Markets closed June 19 (Juneteenth).** Reopen Monday June 22.

### Sector Snapshot
- **Semiconductors (SMH):** $659.88, +5.76% strong momentum. AI capex supercycle driving outsized demand. Global semi sales forecast +26.3% YoY to $975.4B in 2026 (AI accelerators, HBM, advanced logic).
- **Nasdaq-100 (QQQ):** ~$708, +11% over 30 days BUT Momentum Indicator crossed below 0 and MACD turned negative (June 4–5). Cautious on new QQQ entries.
- **Tech (XLK):** +56.58% total return past 12 months; earnings for XLK members up 43% in 2026, +24% expected in 2027.

### Name Research
**NVDA (NVIDIA):** $210.33 (June 18). Confirmed uptrend, currently in ~4.7% pullback phase off recent high. 52-week range: $142.03–$236.54. Technical picture: 15 bullish vs 11 bearish indicators (slight bullish lean). Anticipated 2026 trading channel: $168.93–$227.70. AI infrastructure leader, hyperscalers still investing heavily ($630–$770B AI capex projected 2026). Opportunity: oversold snapback + momentum leader. Risk: "neutral" technicals, not a screaming setup.

**SMH (VanEck Semiconductor ETF):** $659.88, +5.76% recent move. Broad semi exposure (NVDA, AVGO, AMD, MU, TSM, etc.). Avoids single-name risk. Strongest ETF momentum in sector universe as of June 2026. AI capex supercycle is the core thesis.

**AVGO (Broadcom):** $408.24 (June 18). Moved BELOW its 50-day MA on June 5 and RSI moved out of overbought on June 4. Bearish signal near-term. +82% over 12 months, AI chip demand strong long-term, but technically weakening. SKIP for now — wait for 50-day MA recapture or better setup.

**AMD:** ~$515–520 (consistent with $516.10 in Fidelity report from May 31). Up strongly in 2026. Analyst consensus "Strong Buy," targets $430–$665 (wide range). SKIP for paper — CJ's Fidelity book is already 45% AMD; paper shouldn't compound that concentration. Also, AMD is already a large holding in the real book, so paper gains there are redundant.

**QQQ:** ~$708. MACD negative, momentum turned. NEUTRAL to bearish short-term signal. SKIP for new entries; will revisit if MACD crosses back positive.

### Candidate Trade Decisions
| Ticker | Decision | Reason |
|--------|----------|--------|
| NVDA | BUY (Monday) | Oversold snapback + AI infra thesis intact; pullback in uptrend |
| SMH | BUY (Monday) | Strong sector momentum; diversified semi exposure; AI capex |
| AVGO | SKIP | Below 50-day MA, bearish near-term signal |
| AMD | SKIP | CJ already 45% AMD in Fidelity; paper shouldn't double-up |
| QQQ | SKIP | MACD negative; momentum turned; wait for confirmation |

### Macro Notes
- US-Iran peace agreement news (mid-June) boosted semis/tech.
- Fed June meeting completed. Post-FOMC calm is supportive.
- VIX recovery from 22 → 16 suggests market absorbed the June 10 spike well.

### API Access
- **Alpaca REST API:** BLOCKED by network egress policy this run. Cannot verify live equity or place orders programmatically.
- **Finnhub API:** BLOCKED same reason.
- **Action required:** Add `paper-api.alpaca.markets` and `finnhub.io` to the network allowlist, or this agent cannot trade. Notified CJ via Discord.

---
