---
type: "memory"
file: "rules"
date: "2026-06-19"
summary: "Quick-reference rules for Bull. CLAUDE.md is the master — it wins any conflict."
---

# Rules — Bull (Aggressive Quality Paper)

> **CLAUDE.md is the master rulebook.** This file is a quick-reference only. If anything conflicts: CLAUDE.md wins.

## Active Profile: AGGRESSIVE (QUALITY) PAPER — Reigned In (2026-06-14)
Conviction in good, liquid, real companies — not day-trade churn, not gambles.

## Sizing Formula
```
shares = (0.07 × equity) ÷ (entry − stop)
```
Then cap at the position limit. Show the math every trade.

## Hard Limits
| Limit | Value |
|-------|-------|
| Risk per trade | 7% of equity |
| Max position | 30% of equity |
| Max sector | 60% of equity |
| Max open positions | 8 |
| Max new trades/week | 6 |
| Min cash buffer | 10% |
| Margin | None |

## Stops
- **Stop on EVERY trade.** Trailing ~20% initial.
- Never remove or widen a stop unilaterally. Propose changes in weekly review.

## Circuit Breakers
| Trigger | Action |
|---------|--------|
| Day P&L ≤ −8% of equity | No new entries today |
| MTD P&L ≤ −25% | STAND DOWN — no new trades until CJ resumes |

## Universe (Quality Only)
**Allowed:** Large- and mid-cap US stocks (price > $10, real revenue, liquid), broad/sector ETFs (SPY/QQQ/XLK/SMH-type).
**Excluded:** Penny stocks (<$10), leveraged/inverse ETFs (no SOXL/TQQQ/3×), crypto, meme/pump names, illiquid/no-volume, pre-revenue lottery tickets.

## Regime Overlay (VIX)
| VIX | Regime | Action |
|-----|--------|--------|
| < 16 | RISK-ON | Full aggression |
| 16–24 | NEUTRAL | Trim sizes ~25%; be choosier |
| > 24 | RISK-OFF | High-conviction only; consider standing down |

## Exit Rules
- **Stop hit:** exit immediately at trailing stop.
- **−12% from entry:** cut unless a dated catalyst is imminent and thesis intact.
- **Thesis break:** reason for entry is gone → exit regardless of P&L.
- **Time stop:** dead money 2–3 weeks with no progress → recycle capital.
- **Target:** scale partial at first target; let runner ride with tightened stop.

## Hard Rules (Never Break)
- Log every trade with a one-line thesis. Honest journals — accountability, not cheerleading.
- Keys from env vars only. Never print, never commit a secret.
- Propose (never silently apply) any rule tweaks to CJ.
- Paper account only — never touch a live endpoint.

## Change Log
- 2026-06-12 — Strategy approved by CJ.
- 2026-06-14 — "Reigned in" update: QUALITY floor enforced, leveraged ETFs removed from universe.
- 2026-06-19 — rules.md created (was missing from repo; all rules were in CLAUDE.md).
