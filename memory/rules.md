---
type: "memory"
file: "rules"
created: "2026-06-19"
authority: "HIGHEST — overrides strategy.md and routine prompts. Only CJ can change these."
---

# Rules — Bull Active Profile (AGGRESSIVE QUALITY PAPER)

> Consolidated from CLAUDE.md ACTIVE PROFILE section (2026-06-14 update by CJ — "reigned in").
> CLAUDE.md + this file win over any routine prompt or strategy.md conflict.

## Profile Identity
**AGGRESSIVE (QUALITY) PAPER** — Aggressive conviction in solid, liquid investments worth holding 1 week to ~5 years. NOT day-trade churn. NOT gambles.

## Sizing
- Risk **7% of equity** per trade: `shares = (0.07 × equity) ÷ (entry − stop)`, then cap at max position %.
- **Max 30%** per position.
- **Max 60%** per sector.
- **Max 8** open positions.
- Keep **~10% cash buffer**.
- **No margin**.

## Stops
- **Stop on EVERY entry** — ~20% trailing (wide enough to ride quality names through normal volatility).
- On a thesis-intact dip, re-evaluate; don't panic-sell.
- **Never remove a stop. Never widen a stop limit yourself.** Propose changes only in the weekly review.

## Circuit Breakers
- **Daily-loss halt: −8% of equity** → place NO new trades that day (management still allowed).
- **Monthly kill-switch: −25% MTD** → write STAND DOWN; place no new trades until CJ resumes.

## Universe (QUALITY ONLY)
**ALLOWED:**
- Liquid US **large- & mid-cap stocks** (real companies, real revenue, price ≥ **$10**)
- Liquid **broad/sector ETFs** (SPY, QQQ, XLK, SMH, etc.)

**EXCLUDED (hard ban):**
- Penny stocks (price < $10)
- **Leveraged/inverse ETFs** (no SOXL, TQQQ, 3× anything)
- **Crypto** (no BTC, ETH, any crypto)
- Meme/pump-and-dump names
- Illiquid / near-zero-volume names
- Pre-revenue lottery tickets

## Horizon
Short-to-medium swing → position: **1 week to ~5 years**. Let winners run. Concentrate in best ideas. Quality over quantity.

## Hard Rules (never break)
1. Stop on every trade. No naked positions.
2. Never widen a limit yourself — propose only in weekly review.
3. Log every trade with a one-line thesis. Be honest.
4. Respect daily halt and monthly kill-switch. Stand down in RISK-OFF.
5. Keys from env vars only (ALPACA_API_KEY, ALPACA_API_SECRET, ALPACA_BASE_URL, FINNHUB_API_KEY, FRED_API_KEY, DISCORD_WEBHOOK_URL). Never print or store a secret.

## Regime Overlay (strategy.md addendum)
- **RISK-ON** (VIX <16): full aggression.
- **NEUTRAL** (16–24): trim new sizes ~25%; be choosier.
- **RISK-OFF** (>24 or major macro event): high-conviction only; consider standing down.

## Change Log
- 2026-06-14 — CJ "reigned in" the profile: added leveraged ETF ban, crypto ban, price floor $10, max position 30%, max sector 60%, max 8 open, 7% risk/trade, daily halt −8%, monthly kill −25%.
- 2026-06-19 — Created this rules.md file (was referenced in CLAUDE.md but missing). Copied from CLAUDE.md active profile. No rule changes.
