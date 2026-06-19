# Research Log — Bull (paper)
# Dated notes from each run's market research. Append; do not overwrite.

---

## 2026-06-19 — Daily Run (Holiday: Juneteenth; no trading)

### REGIME: NEUTRAL (VIX ~16.41)
VIX at 16.41 as of June 16 close. Per strategy.md: 16–24 = NEUTRAL → trim new sizes ~25%,
be choosier on entries.

**Fed (June 17 decision):** Held rates at 3.5–3.75% as expected (97% probability pre-meeting).
HAWKISH dot plot — median now expects rates to END 2026 higher than current level (flip from
March when a cut was expected). 17 of 18 Fed officials see upside risk to inflation.
Fed-funds futures now pricing 77% probability of a hike by December 2026 (up from 24% a month
ago). Meaningful headwind for high-multiple growth stocks going into H2.

**Iran/geopolitics:** U.S.–Iran peace deal (~June 11–15) removed tail risk; oil lower; broadly
market-positive.

**Market status:** NYSE/Nasdaq CLOSED June 19 (Juneteenth federal holiday). Last trading day
was June 17, 2026.

---

### MARKET PERFORMANCE (last close June 17, 2026)
| Instrument | Close | Day Chg | YTD |
|------------|-------|---------|-----|
| SPY | ~$698 (est.) | +0.10% | ~+3% (est.) |
| QQQ | $722.51 | −1.01% | +17.57% |
| NVDA | $206.66 | +0.98% | ~+10% |
| AVGO | $392.90 | n/a | ~+11% |
| SMH | n/a | n/a | +72.15% |

---

### KEY RECENT EVENTS
- **June 5:** Semiconductor sector selloff. SMH −9.2%, QQQ −4.8%, SPY −2.6%. ~$1T in market cap
  erased. Triggered by AVGO cautious broader AI chip commentary + memory chip supply concerns +
  global smartphone demand weakness.
- **June 11–15:** Recovery on Iran/U.S. peace deal. MU +8%, AMD +4%, NVDA +2%+ on June 15.
- **June 17:** Fed held rates; hawkish dot plot. QQQ −1.01%, S&P +0.10% (mixed).
- **June 19:** Market CLOSED (Juneteenth).

---

### CANDIDATE IDEAS FOR MONDAY (2026-06-22)

**NVDA — HIGH CONVICTION**
- AI GPU market leader; structural moat in training + inference; no credible GPU competitor
- Price ~$207; only ~10% YTD despite SMH up 72% — suggests individual name lagged sector ETF,
  possible relative catch-up trade
- Post-June-5-selloff recovery to $207 shows buy-the-dip conviction
- AVGO Q2 AI guide ($10.7B, +140% YoY) directly confirms hyperscaler GPU demand
- Risk: Fed hawkishness = P/E compression; entry only if Monday open is not an adverse gap

**AVGO — HIGH CONVICTION**
- Q1 AI rev $8.4B (+106% YoY); Q2 guide $10.7B (+140% YoY)
- Custom silicon/ASIC wins at Google, Meta; AI Ethernet networking
- 48-analyst "Strong Buy"; consensus $522 target (~+28% from $393)
- Post-selloff (June 5) recovery to $392.90 = buyers absorbed the dip
- Risk: Was the catalyst of the June 5 selloff (broader commentary cautious); valuation rich

**QQQ — MEDIUM CONVICTION (alternative/complement)**
- Diversified large-cap tech exposure; less single-name risk
- $722.51 close; +17.57% YTD
- Would use as a replacement if individual semi names look extended Monday

**PASS / AVOID:**
- SMH: +72% YTD is an exhausted run; hawkish Fed headwind; wait for a better entry
- Leveraged ETFs: Excluded per CLAUDE.md (NO SOXL/TQQQ/3x)
- Crypto: Excluded per CLAUDE.md
- Sub-$10 stocks: Excluded per CLAUDE.md

---

### SIZING WORKSHEET (NEUTRAL regime — trim 25%; 7% risk/trade per CLAUDE.md; 30% position cap)

**NVDA** (entry $207, 18% trail → stop $169.74):
```
raw shares = (0.07 × $100,000) / ($207.00 − $169.74) = $7,000 / $37.26 = 187 shares
cost = 187 × $207 = $38,709 → 38.7% → EXCEEDS 30% cap
cap to 30%: $30,000 / $207 = 144 shares ($29,808)
NEUTRAL −25%: 144 × 0.75 = 108 shares → $22,356 = 22.4%
```

**AVGO** (entry $393, 18% trail → stop $322.26):
```
raw shares = $7,000 / ($393.00 − $322.26) = $7,000 / $70.74 = 98 shares
cost = 98 × $393 = $38,514 → 38.5% → EXCEEDS 30% cap
cap to 30%: $30,000 / $393 = 76 shares ($29,868)
NEUTRAL −25%: 76 × 0.75 = 57 shares → $22,401 = 22.4%
```

Combined: 44.8% deployed; cash 55.2%; sector 44.8%; 2 positions open.

---

### INFRASTRUCTURE NOTES
- Alpaca API (paper-api.alpaca.markets) blocked by network egress in the Claude Code scheduled
  run environment. Research/journaling proceeds; execution requires egress allowlist fix.
- ALPACA_BASE_URL env var already includes `/v2` suffix — any curl call should use
  `$ALPACA_BASE_URL/account` not `$ALPACA_BASE_URL/v2/account` to avoid double-path.
