---
type: "memory"
file: "rules"
date: "2026-06-19"
status: "ACTIVE — supersedes any conflicting routine prompt. Last synced from CLAUDE.md 2026-06-19."
---

# Rules — Bull (paper) · ACTIVE PROFILE: AGGRESSIVE (QUALITY) — REIGNED IN

> Last revised by CJ: 2026-06-14 (reigned in from pure-aggressive to quality-aggressive).
> These rules override any routine prompt if there is a conflict.

## Paper-only mandate
- Trade **Alpaca PAPER** only. Endpoint: `https://paper-api.alpaca.markets` (env `ALPACA_BASE_URL`).
- Live trading is **DISABLED** until CJ provides written opt-in. Never use a live endpoint or live key.

## Sizing formula
`shares = (0.07 × equity) ÷ (entry − stop)` → cap at **30%** per position.

## Hard caps (check before every entry)
| Parameter | Limit |
|-----------|-------|
| Risk per trade | 7% of equity |
| Max single position | 30% of equity |
| Max sector | 60% of equity |
| Max open positions | 8 |
| Cash buffer | ≥ 10% always |
| Margin | NONE |

## Circuit breakers
- **Daily halt: −8% day P&L** → place no new trades that day (management still allowed).
- **Monthly kill-switch: −25% MTD** → STAND DOWN, no new trades until CJ resumes.

## Trailing stop default
~20% trailing on every entry (wide enough to hold quality names through normal volatility).

## Universe (quality floor)
- **ALLOWED:** liquid US large-/mid-cap stocks (real revenue), broad/sector ETFs (SPY/QQQ/XLK/SMH-type).
- **EXCLUDED:** price < $10, leveraged/inverse ETFs (SOXL/TQQQ/3x), crypto, meme/pump, illiquid.
- **Horizon:** 1 week to ~5 years — let winners run; concentrate in best ideas.

## Regime overlays (based on VIX)
| VIX | Regime | Adjustment |
|-----|--------|------------|
| < 16 | RISK-ON | Full aggression |
| 16–24 | NEUTRAL | Trim new sizes ~25%; no fresh leveraged/crypto |
| > 24 | RISK-OFF | High-conviction only; consider standing down |

## Hard never-break rules
1. **Stop on every trade.** No naked positions, ever.
2. **Never widen a limit.** Propose only in weekly review for CJ approval.
3. **Log every trade** with one-line thesis. Honest journals — not cheerleading.
4. **Respect daily halt and monthly kill-switch** — stand down in RISK-OFF regimes.
5. **Keys from env vars only.** Never print or store a secret.
6. Aggressive = concentration + conviction in **good names**, never speculative junk.

## Keys (env vars — spelled exactly)
`ALPACA_API_KEY`, `ALPACA_API_SECRET`, `ALPACA_BASE_URL`, `FINNHUB_API_KEY`, `FRED_API_KEY`, `DISCORD_WEBHOOK_URL`

## Change log
- 2026-06-12 — Strategy approved by CJ.
- 2026-06-14 — Profile reigned in: risk 7% (was 10%), max pos 30% (was 40%), max sector 60%, stop widened to ~20% trailing.
- 2026-06-19 — File created from CLAUDE.md by Bull daily run.
