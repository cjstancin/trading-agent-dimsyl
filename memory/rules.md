---
type: "memory"
file: "rules"
date: "2026-06-14"
updated: "2026-06-19"
status: "ACTIVE — Aggressive (Quality) Paper, reigned in by CJ 2026-06-14"
---

# Rules — Bull (Active Profile)

> Profile locked by CJ 2026-06-14. These rules WIN over any conflicting routine prompt.
> CLAUDE.md is the master; this file captures the key operating parameters for quick lookup.

## Account
- **Account:** Alpaca PAPER only. Endpoint `https://paper-api.alpaca.markets`.
- **Live trading:** DISABLED permanently until CJ opts in writing.
- **Starting equity:** $100,000 USD (paper sandbox).

## Active Profile: AGGRESSIVE (QUALITY) — reigned in
Conviction trades on **solid, liquid, quality names** you'd hold 1 week to 5 years. No churn, no gambles.

## Sizing
- **Risk per trade:** 7% of equity.
- **Formula:** `shares = (0.07 × equity) ÷ (entry − stop)`, then cap at max position %.
- **Max position:** 30% of equity per name.
- **Max sector:** 60% of equity.
- **Max open positions:** 8.
- **Cash buffer:** Keep ≥10% cash at all times.
- **No margin.**

## Stops
- **Trailing stop:** ~20% on every entry (wide enough to hold quality through normal vol).
- **Stop on EVERY entry, no exceptions.** No naked positions ever.
- **Cut rule:** down ~−12% from entry → exit unless dated catalyst imminent + thesis intact.
- **Time stop:** dead money after ~2–3 weeks with no progress → recycle capital.
- **Thesis break:** if the reason you bought is gone → exit regardless of P&L.

## Circuit Breakers
- **Daily-loss halt:** −8% of equity that day → place NO new trades.
- **Monthly kill-switch:** −25% MTD → STAND DOWN, no new trades until CJ resumes.

## Regime Overlay (VIX)
- **RISK-ON** (VIX < 16): full aggression.
- **NEUTRAL** (VIX 16–24): trim new sizes ~25%; be choosier.
- **RISK-OFF** (VIX > 24 or major macro event): high-conviction only; consider standing down.

## Universe (QUALITY ONLY)
**Allowed:**
- Liquid US large- and mid-cap stocks (real companies, real revenue).
- Liquid broad/sector ETFs: SPY, QQQ, XLK, SMH, and similar.

**EXCLUDED:**
- Penny stocks (price < $10).
- Leveraged/inverse ETFs (SOXL, TQQQ, 3× anything — hard excluded).
- Crypto (hard excluded in this profile).
- Meme/pump names, illiquid/no-volume, pre-revenue lottery tickets.

## Hard Rules (never break)
1. Stop on every trade. No exceptions.
2. Never widen a limit mid-trade. Propose changes in weekly review for CJ's approval.
3. Log every trade with a one-line thesis. Honest journals — no cheerleading.
4. Respect daily halt and monthly kill-switch.
5. Keys from env vars only — never print or store secrets.
6. Be aware CJ's real Fidelity book (~$80k) is ~99% tech (AMD/MSFT). Don't blindly pile on same names.

## Key Env Vars
`ALPACA_API_KEY`, `ALPACA_API_SECRET`, `ALPACA_BASE_URL`, `FINNHUB_API_KEY`, `FRED_API_KEY`, `DISCORD_WEBHOOK_URL`

## Change Log
- 2026-06-14 — CJ reigned in profile from raw-aggressive to "aggressive quality". Key changes: risk/trade 7% (was 10%), max position 30% (was 40%), stop 20% (was 18%), daily halt -8% (was -10%), monthly kill -25% (was -30%), leveraged ETFs and crypto hard-excluded.
- 2026-06-19 — File created by Bull (daily run). No rule changes; transcribing from CLAUDE.md for quick lookup.
