---
type: "memory"
file: "rules"
date: "2026-06-19"
status: "ACTIVE — aggressive quality paper profile (reigned in 2026-06-14 by CJ)"
---

# Rules — Bull (aggressive paper) · ACTIVE PROFILE

> CLAUDE.md is the master rulebook. This file is the operational quick-reference. If anything here conflicts with CLAUDE.md, CLAUDE.md wins.

## Active Profile: AGGRESSIVE (QUALITY) PAPER — reigned in 2026-06-14

| Parameter | Value |
|-----------|-------|
| Risk per trade | 7% of equity |
| Max position | 30% of equity |
| Max sector | 60% of equity |
| Max open positions | 8 |
| Cash buffer | ~10% minimum |
| Trailing stop | ~20% (default) |
| Margin | NEVER |
| Daily loss halt | −8% equity |
| Monthly kill-switch | −25% MTD → STAND DOWN |

## Sizing Formula
`shares = (0.07 × equity) ÷ (entry − stop)` → cap result at 30% of equity

In NEUTRAL regime (VIX 16–24): trim sizing by ~25%.
In RISK-OFF regime (VIX >24): high-conviction only, avoid new leveraged/crypto.

## Universe (QUALITY ONLY)
- **ALLOWED:** Liquid US large/mid-cap stocks (price ≥ $10, real revenue), broad/sector ETFs (SPY, QQQ, XLK, SMH)
- **EXCLUDED:** Penny stocks (<$10), leveraged/inverse ETFs (SOXL, TQQQ, 3×), crypto, meme/pump names, pre-revenue

## Entry Triggers (need 2+ to act)
1. Breakout above multi-week/52-week high on above-avg volume
2. Momentum leader in hot sector vs SPY relative strength
3. Oversold snapback: quality name −15%+ on no broken fundamentals
4. Dated catalyst: earnings beat, product launch, FDA, index inclusion
5. (RISK-ON only) Sector conviction → broad ETF expression

## Exit Rules
- **Stop:** ~20% trailing — never remove
- **Cut:** −12% from entry unless dated catalyst imminent + thesis intact
- **Target:** trim into strength; let runners ride with tightened stop
- **Thesis break:** reason you bought is gone → exit regardless of P&L
- **Time stop:** dead money 2–3 weeks → recycle capital

## Circuit Breakers
- MTD ≤ −25% → STAND DOWN — write in portfolio.md, place NO new trades until CJ resumes
- Day ≤ −8% → no NEW entries today (manage existing OK)

## Endpoints
- Paper: `$ALPACA_BASE_URL` (must contain paper-api.alpaca.markets)
- Keys: `ALPACA_API_KEY`, `ALPACA_API_SECRET`
- Data: `https://data.alpaca.markets`

## Change Log
- 2026-06-12 — Initial aggressive profile created
- 2026-06-14 — CJ reigned in: quality-only universe, no leveraged ETFs, reduced risk to 7%, max position 30%, max 8 open
- 2026-06-19 — This file created (was missing from repo); content mirrors CLAUDE.md active profile
