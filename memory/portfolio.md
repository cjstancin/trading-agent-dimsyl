---
type: "memory"
file: "portfolio"
date: "2026-06-19"
---

# Portfolio — Bull (paper) · 2026-06-19

> Updated: 2026-06-19 (Juneteenth — market holiday; Alpaca API blocked in scheduled environment)
> Last confirmed Alpaca sync: 2026-06-14 (equity $100,000)

## ACCOUNT SNAPSHOT
| Field | Value |
|-------|-------|
| Equity | $100,000.00 |
| Cash | $100,000.00 |
| Buying power | $100,000.00 (no margin) |
| Day P&L | $0 — market closed (Juneteenth) |
| MTD P&L | $0.00 (0.00%) |
| YTD P&L | $0.00 (0.00%) |
| Open positions | 0 |
| Open orders | 0 |
| Regime | NEUTRAL (VIX ~16.41; hawkish Fed dot plot) |
| Alpaca API | BLOCKED — paper-api.alpaca.markets not in egress allowlist |

## OPEN POSITIONS
None.

## PENDING ORDERS
None placed (market closed + API blocked).

---

## MONDAY (2026-06-22) TRADE PLAN — Place limit orders at/near open

These have NOT been submitted to Alpaca. Markets were closed today (Juneteenth) and the API is
network-blocked in this run environment. Place these when markets open June 22.

### 1. NVDA (NVIDIA Corporation) — HIGH CONVICTION LONG
- **Entry:** ~$207.00 (limit at or within 0.5% of open)
- **Trailing stop:** 18% GTC (set immediately after fill)
- **Size:** 108 shares ≈ $22,356 ≈ 22.4% of equity
- **Sizing math:** (0.07 × $100k) / ($207 − $169.74) = 187 shares → capped 30% = 144 → NEUTRAL −25% = 108
- **Thesis:** AI GPU monopoly; hyperscaler capex accelerating (AVGO Q2 AI guide +140% YoY confirms demand); structural moat in training/inference. Post-selloff recovery shows buyer conviction.
- **Risk:** Hawkish Fed = multiple compression on high-P/E names. Entry only if NVDA is not gapping >2% down from June 17 close ($206.66).

### 2. AVGO (Broadcom Inc.) — HIGH CONVICTION LONG
- **Entry:** ~$393.00 (limit at or within 0.5% of open)
- **Trailing stop:** 18% GTC (set immediately after fill)
- **Size:** 57 shares ≈ $22,401 ≈ 22.4% of equity
- **Sizing math:** (0.07 × $100k) / ($393 − $322.26) = 98 shares → capped 30% = 76 → NEUTRAL −25% = 57
- **Thesis:** Q1 AI revenue $8.4B (+106% YoY); Q2 AI guide $10.7B (+140% YoY). Custom silicon for Google/Meta; AI Ethernet networking is critical AI infra. 48-analyst consensus "Strong Buy"; $522 target (+28% upside). Dip recovery confirms buyer demand.
- **Risk:** Originated the June 5 selloff with cautious broader commentary; stretched valuation.

### PORTFOLIO CHECK (if both filled Monday)
| Metric | Value | Cap | Status |
|--------|-------|-----|--------|
| NVDA position | 22.4% | 30% | ✓ |
| AVGO position | 22.4% | 30% | ✓ |
| Total deployed | 44.8% | — | ✓ |
| Cash remaining | 55.2% | ≥10% | ✓ |
| Tech/Semi sector | 44.8% | 60% | ✓ |
| Open positions | 2 | 8 max | ✓ |
| New this week | 2 | 6 max | ✓ |

---

## CIRCUIT BREAKERS
| Check | Value | Threshold | Status |
|-------|-------|-----------|--------|
| MTD P&L | 0% | −25% kill | CLEAR |
| Day P&L | $0 | −8% halt | CLEAR — market closed |

---

## INFRASTRUCTURE BLOCKER
Alpaca API (paper-api.alpaca.markets) is not in the network egress allowlist for scheduled cloud
runs. **CJ action required:** Add `paper-api.alpaca.markets` to the egress allowlist in Claude
Code on the Web settings so the agent can verify balances and execute paper orders. Until then,
orders must be placed manually on the Alpaca paper dashboard, or the agent must be run in an
environment with network access to that host.
