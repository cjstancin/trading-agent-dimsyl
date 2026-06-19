---
type: "memory"
file: "rules"
updated: "2026-06-19"
status: "ACTIVE — Aggressive (Quality) Paper profile, reigned in per CJ 2026-06-14"
---

# Rules — Bull (paper) · ACTIVE PROFILE: AGGRESSIVE (QUALITY)

> This file + CLAUDE.md override any routine prompt. Last reconciled: 2026-06-19.

## Active profile: AGGRESSIVE (QUALITY) PAPER — reigned in (CJ 2026-06-14)

Aggressive conviction, but on **solid, liquid investments** you'd be comfortable holding 1 week to ~5 years.
No day-trade churn. No gambles.

## Hard sizing limits

| Parameter | Limit |
|-----------|-------|
| Risk per trade | 7% of equity |
| Sizing formula | `shares = (0.07 × equity) ÷ (entry − stop)` then cap at max position |
| Max position | 30% of equity |
| Max sector | 60% of equity |
| Max open positions | 8 |
| Min cash buffer | ~10% |
| Margin | NEVER |

## Stops

- **Stop on EVERY entry** — ~20% trailing (wide enough to ride quality names through normal volatility)
- Implementation target: 18% trailing stop order placed simultaneously with entry
- Never widen a stop unilaterally — only propose changes in weekly review for CJ's approval
- On thesis-intact dip: re-evaluate; don't panic-sell

## Circuit breakers

| Breaker | Threshold | Action |
|---------|-----------|--------|
| Daily-loss halt | −8% of equity today | Place no new trades that day; manage existing only |
| Monthly kill-switch | −25% MTD | "STAND DOWN — no new trades" until CJ resumes |

## Universe (QUALITY ONLY)

**ALLOWED:** liquid US large- & mid-cap stocks (real companies, real revenue), liquid broad/sector ETFs (SPY/QQQ/XLK/SMH-type)

**EXCLUDED:**
- Penny stocks (price < $10)
- Leveraged/inverse ETFs (no SOXL/TQQQ/3×)
- Crypto
- Meme/pump names
- Illiquid / no-volume
- Pre-revenue lottery tickets

## Regime overlay (from strategy.md)

| VIX | Regime | Action |
|-----|--------|--------|
| < 16 | RISK-ON | Full aggression |
| 16–24 | NEUTRAL | Trim new sizes ~25%; be choosier |
| > 24 | RISK-OFF | High-conviction only; avoid fresh leveraged/crypto; consider standing down |

## Horizon

Short-to-medium swing → position (1 week to ~5 years). Let winners run. Concentrate in best ideas. Quality over quantity.

## Non-negotiables (never break)

1. Stop on every trade. No naked positions.
2. Never widen a limit unilaterally.
3. Log every trade with a one-line thesis.
4. Respect daily halt and monthly kill-switch.
5. Keys from env vars only — never print or store a secret.
6. PAPER endpoint only (`https://paper-api.alpaca.markets`). Live is DISABLED.
7. Never conflate paper account with CJ's real Fidelity book.

## Locked live profile

Live trading is a separate, future, **written** opt-in by CJ. Live uses a LOCKED conservative profile — NOT the aggressive paper profile. The paper endpoint is the ONLY permitted endpoint right now.
