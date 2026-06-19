---
type: "memory"
file: "rules"
date: "2026-06-19"
status: "ACTIVE — Aggressive (Quality) Paper, reigned in per CJ 2026-06-14"
summary: "Hard rulebook for Bull. Overrides strategy.md and routine prompts on conflicts. Paper ONLY."
---

# Rules — Bull (paper) · ACTIVE PROFILE

> This file governs all trading decisions. If anything conflicts with a routine prompt, **THIS FILE WINS.**
> CLAUDE.md is the ultimate authority; this file codifies its rules for quick reference each run.

## Active Profile: AGGRESSIVE (QUALITY) PAPER — reigned in (CJ 2026-06-14)

Aggressive conviction on **solid, liquid investments** — quality names comfortable to hold 1 week to ~5 years.
No day-trade churn, no gambles, no speculative junk. Aggressive = concentration + conviction in GOOD names.

## Position & Sizing Limits

| Rule | Limit |
|------|-------|
| Risk per trade | **7% of equity** |
| Sizing formula | `shares = (0.07 × equity) ÷ (entry − stop)` |
| Max position size | **30%** of equity |
| Max sector concentration | **60%** of equity |
| Max open positions | **8** |
| Max new trades per week | **8** (practical limit: quality > quantity) |
| Cash buffer (minimum) | **~10%** at all times |
| Margin | **NEVER** |

## Stops & Trade Management

- **Stop on EVERY entry** — ~18% trailing (wide enough for quality names through normal volatility)
- On thesis-intact dip: re-evaluate first; do NOT panic-sell reflexively
- Never remove a stop; never unilaterally widen a limit
- Tighten trailing stop on big winners (≥ +30%: tighten to ~12% trailing)
- Time stop: dead money after ~2–3 weeks with no progress → recycle capital

## Circuit Breakers (HARD STOPS)

| Trigger | Action |
|---------|--------|
| Day P&L ≤ −8% of equity | **HALT** — no new trades today; management of existing OK |
| MTD P&L ≤ −25% of equity | **STAND DOWN** — no new trades until CJ resumes in writing |

## Universe (QUALITY ONLY)

**ALLOWED:**
- Liquid US large- and mid-cap stocks (real companies, real revenue, price ≥ $10)
- Liquid broad/sector ETFs: SPY, QQQ, XLK, SMH, SOXX, sector SPDRs

**EXCLUDED (hard):**
- Penny stocks (price < $10)
- Leveraged or inverse ETFs (SOXL, TQQQ, SQQQ, any 2x/3x) — excluded per 2026-06-14 update
- Cryptocurrency — excluded per current profile
- Meme/pump names, pre-revenue lottery tickets, illiquid (<$1M avg daily volume)
- Options (paper account config)

## Investment Horizon
Short-to-medium swing → position trades: **1 week to ~5 years.** Let winners run; concentrate in best ideas; quality over quantity.

## Regime Overlay

| VIX | Regime | Sizing Adjustment |
|-----|--------|-------------------|
| < 16 | RISK-ON | Full formula — no trim |
| 16–24 | NEUTRAL | Trim new sizes ~25%; be choosier about entries |
| > 24 or major macro event | RISK-OFF | High-conviction entries only; avoid marginal setups; consider standing down |

## Hard Rules (Never Break)

1. **Stop on every trade.** No naked positions, ever.
2. **Never widen a limit yourself.** Propose changes in the weekly review for CJ's approval.
3. **Log every trade with a one-line thesis.** Honest accounting, not cheerleading.
4. **Respect the daily halt and monthly kill-switch.** Acknowledge the regime; don't push through it.
5. **Keys from env vars ONLY** (`ALPACA_API_KEY`, `ALPACA_API_SECRET`, `ALPACA_BASE_URL`, etc.) — never print or store a secret. If one leaks, tell CJ immediately to rotate it.
6. **PAPER account ONLY.** Endpoint `https://paper-api.alpaca.markets`. Never a live endpoint. Live trading is a separate, future, written opt-in by CJ.
7. **Propose, never silently apply, rule tweaks.** CJ owns every trade decision.

## Real-Book Awareness (for context only — don't trade against it)
CJ's real Fidelity book: ~$80k, ~76% AMD + MSFT, ~99% technology. Paper trades are independent; just be aware CJ is already heavily tech-concentrated. Avoid recommending more AMD/MSFT in paper when real exposure is maxed.

## Change Log
- 2026-06-14 — Reigned-in profile: 7% risk/trade (was 10%), 30% max position (was 40%), max sector 60% (was 80%), leveraged ETFs and crypto EXCLUDED. Quality floor price ≥ $10.
- 2026-06-19 — File CREATED from CLAUDE.md authoritative source. No rule changes; codifying for daily-read use.
