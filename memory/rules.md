---
type: "memory"
file: "rules"
date: "2026-06-12"
last-updated: "2026-06-14"
status: "ACTIVE — Aggressive (Quality) Paper profile, reigned in 2026-06-14 by CJ"
---

# Rules — Bull (Aggressive Quality Paper Profile)

> These rules override any routine prompt. When in doubt, follow these. Never break a hard rule even if the math says to.

## Profile: AGGRESSIVE (QUALITY) PAPER — reigned in (CJ 2026-06-14)

Aggressive conviction, but on **solid, liquid investments** you'd be comfortable holding 1 week to ~5 years. NOT day-trade churn, NOT speculative gambles.

---

## Sizing Formula
```
shares = (0.10 × equity) ÷ (entry − stop)
cap at 40% of equity per position
```
Under NEUTRAL regime (VIX 16–24): trim effective risk by ~25%.

---

## Hard Position Limits
| Rule | Limit |
|------|-------|
| Risk per trade | 10% of equity |
| Max position | 40% of equity |
| Max sector | 80% of equity |
| Max open positions | 6 |
| Max new trades/week | 6 |
| Min cash buffer | ~10% |
| Margin | NEVER |
| Trailing stop (default) | ~18% |

---

## Circuit Breakers (never override)
- **Daily halt: −10%** of equity intraday → no new entries that day; manage only
- **Monthly kill-switch: −30% MTD** → STAND DOWN; no new trades until CJ resumes

---

## Universe (QUALITY ONLY)
**Allowed:**
- Liquid US large- & mid-cap stocks (real revenue, real companies)
- Liquid broad/sector ETFs (SPY, QQQ, XLK, SMH-type)

**EXCLUDED:**
- Penny stocks (price < $10)
- Leveraged/inverse ETFs (SOXL, TQQQ, 3× anything)
- Crypto (paper sandbox excludes per CLAUDE.md active profile)
- Meme/pump names, illiquid, pre-revenue lottery tickets

---

## Entry Triggers (need 2+ to enter)
1. Breakout above multi-week/52-week high on above-average volume
2. Momentum leader in hot sector (semis, AI) showing relative strength vs SPY
3. Oversold snapback: quality name down 15%+ on no broken fundamentals, turning up
4. Near-term dated catalyst (earnings beat, product launch)

---

## Exit Rules
- **Stop**: ~18% trailing on every position. Never remove, never widen manually.
- **Cut**: position −12% from entry → exit unless dated catalyst imminent and thesis intact
- **Thesis break**: reason for entry is gone → exit regardless of P&L
- **Time stop**: dead money after 2–3 weeks with no progress → recycle capital
- **Trim into strength**: at first target, trim; let runner trail

---

## Hard Rules (never break)
1. Stop on EVERY trade. No naked positions.
2. Never widen a limit order yourself. Propose changes in weekly review for CJ's approval.
3. Log every trade with a one-line thesis. Be honest.
4. Respect the daily halt and monthly kill-switch.
5. Keys from env vars ONLY. Never print or store a secret.
6. PAPER account ONLY. Endpoint must be `https://paper-api.alpaca.markets`. Never live.
7. Never exceed caps — size, sector, position count.

---

## Regime Overlay
| VIX Level | Regime | Action |
|-----------|--------|--------|
| < 16 | RISK-ON | Full aggression |
| 16–24 | NEUTRAL | Trim sizes ~25%, be choosier |
| > 24 | RISK-OFF | High-conviction only; consider standing down |

---

## Change Log
- 2026-06-12 — Rules created alongside initial strategy approval
- 2026-06-14 — CJ tightened profile: quality-only universe, no leveraged ETFs, no crypto, price ≥ $10, horizon 1 week to 5 years
- 2026-06-19 — Confirmed active. Alpaca API blocked from remote env — need egress allowlist entry for paper-api.alpaca.markets
