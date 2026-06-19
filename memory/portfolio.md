---
type: "memory"
file: "portfolio"
date: "2026-06-19"
updated: "2026-06-19 (daily run — Juneteenth, market closed)"
---

# Portfolio — Bull (Alpaca PAPER)

> This is the paper trading sandbox. CJ's real money is at Fidelity (see real-portfolio-fidelity.md).
> Last updated: 2026-06-19 by Bull daily run.

## Account Snapshot
| Field | Value |
|-------|-------|
| Equity | $100,000.00 |
| Cash | $100,000.00 |
| Buying Power | ~$100,000 (no margin) |
| Day P&L | $0.00 (0.00%) |
| Month P&L (Jun) | $0.00 (0.00%) |
| vs S&P 500 (MTD) | ~−2.7% (SPY rose ~2.7% since benchmark set; we are flat) |

> Note: Alpaca REST API was unreachable this run (host not in network allowlist). Equity shown is from last verified state (June 14, 2026 dashboard). No position changes to reconcile.

## Open Positions
**None.** Account is 100% cash.

## Open Orders
**None.**

## Pending Plan (Monday June 22, 2026 — market reopen after Juneteenth)
Markets were CLOSED today (Juneteenth, federal holiday). These are planned entries for Monday open — subject to price check and circuit-breaker confirmation before placing.

| Ticker | Side | Planned Qty | Entry Target | Stop (20% trailing) | Cost (est.) | % Equity | Thesis |
|--------|------|-------------|--------------|----------------------|-------------|----------|--------|
| NVDA | BUY | 125 shares | ~$210 limit | 20% trailing (~$168 initial) | ~$26,250 | 26.3% | AI infra leader in confirmed uptrend, ~5% pullback from recent high, neutral-bullish technicals; upside to 52-wk high $236.54 |
| SMH | BUY | 39 shares | ~$660 limit | 20% trailing (~$528 initial) | ~$25,740 | 25.7% | Semi sector ETF showing strong momentum (+5.76%), diversified single-name risk; AI capex supercycle, global semi sales +26.3% YoY in 2026 |

**After both fills (if both execute Monday):**
- Open positions: 2 / 8 max ✓
- Tech/Semi sector exposure: ~52% / 60% max ✓
- Cash remaining: ~$48,010 (48%) ✓
- All positions have stops ✓

## Sizing Math (Monday plan)
**Equity at time of sizing:** $100,000 | **Regime:** NEUTRAL (VIX ~16.4) → size −25%

**NVDA:**
- Risk per trade: 7% × $100,000 = $7,000
- Entry: $210, Stop basis: $210 × 0.80 = $168 → risk/share = $42
- Raw shares: $7,000 / $42 = 166.7
- NEUTRAL adjustment (−25%): 125 shares
- Cost: 125 × $210 = $26,250 (26.3%) ✓ < 30% cap

**SMH:**
- Risk per trade: 7% × $100,000 = $7,000
- Entry: $660, Stop basis: $660 × 0.80 = $528 → risk/share = $132
- Raw shares: $7,000 / $132 = 53.0
- NEUTRAL adjustment (−25%): 39 shares
- Cost: 39 × $660 = $25,740 (25.7%) ✓ < 30% cap

## Notes
- CJ's Fidelity book is ~99% tech (AMD 45%, MSFT 31%). Paper account trades complement; avoiding heavy AMD/MSFT overlap.
- Network policy blocked Alpaca REST calls this run. Orders will be placed Monday when API is available.
- Regime: NEUTRAL (VIX ~16.4 as of June 16). Full risk-on threshold is VIX < 16.

## Change Log
- 2026-06-19 — File created. First daily run. Account fresh ($100k cash). Market closed (Juneteenth). Planned 2 entries for Monday.
