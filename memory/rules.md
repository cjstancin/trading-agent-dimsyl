---
type: "memory"
file: "rules"
updated: "2026-06-19"
authority: "CLAUDE.md (active profile section, CJ reigned-in 2026-06-14). This file wins over strategy.md and daily-run prompts on any conflict."
---

# Rules — Bull · ACTIVE = Aggressive (Quality) Paper (reigned-in 2026-06-14)

> Hard rules. CLAUDE.md + this file override everything else, including the strategy.md and run prompts.

## Account
- **Paper only.** Endpoint: `$ALPACA_BASE_URL` = `https://paper-api.alpaca.markets` (never live).
- Keys from env only: `ALPACA_API_KEY`, `ALPACA_API_SECRET`, `ALPACA_BASE_URL`, `FINNHUB_API_KEY`, `FRED_API_KEY`, `DISCORD_WEBHOOK_URL`. Never print, log, or commit a secret.

## Universe (eligible instruments)
- ✅ Liquid US **large- and mid-cap stocks** (real companies, real revenue)
- ✅ **Liquid broad/sector ETFs**: SPY, QQQ, XLK, SMH, etc.
- ❌ Penny stocks (price < **$10**)
- ❌ **Leveraged/inverse ETFs** (no SOXL, TQQQ, 3× anything)
- ❌ Crypto (no BTC, ETH, etc. — note: earlier strategy.md allowed this; CLAUDE.md overrides)
- ❌ Meme/pump names, pre-revenue lottery tickets, illiquid/no-volume

## Sizing (run before every entry)
`shares = (0.07 × equity) ÷ (entry − stop)` then cap at **30% per position**.

## Hard Position Caps
| Limit | Value |
|-------|-------|
| Risk per trade | 7% of equity |
| Max per position | 30% of equity |
| Max sector | 60% |
| Max open positions | 8 |
| Max new trades/week | See strategy |
| Cash buffer (min) | ~10% |
| Margin | NEVER |

## Stops (mandatory)
- **Stop on every entry.** No naked positions ever.
- Default trailing stop: **~20%** (wide enough to ride quality names through normal vol).
- Never widen a stop yourself mid-trade. Propose only in the weekly review for CJ approval.
- On thesis-intact dip: re-evaluate; don't panic-sell. On thesis break: exit regardless of P&L.

## Circuit Breakers
| Trigger | Action |
|---------|--------|
| Daily loss ≤ **−8%** of equity | Place no new trades that day. Management (stops, exits) allowed. |
| MTD loss ≤ **−25%** | **STAND DOWN** — no new trades until CJ resumes. Write the trigger. |

## Regime Overlay
| VIX | Regime | Action |
|-----|--------|--------|
| < 16 | RISK-ON | Full aggression; concentration |
| 16–24 | NEUTRAL | Trim new sizes ~25%; be choosier |
| > 24 | RISK-OFF | High-conviction only; consider standing down |

## Trade Discipline
- Log every trade with a one-line thesis (be honest, not cheerleading).
- Cut: position down ~−12% from entry → exit unless dated catalyst imminent and thesis intact.
- Time stop: dead money after ~2–3 weeks → recycle.
- Never widen a limit mid-trade.
- Propose rule tweaks in the weekly review only — never silently apply them.

## Horizon
Short-to-medium swing → position (**1 week to ~5 years**). Let winners run; concentrate in best ideas.

## Conflicts
When strategy.md, run prompts, or approved-cycle.md conflict with this file or CLAUDE.md, **this file and CLAUDE.md win.**

## Change log
- 2026-06-12 — Initial aggressive paper profile active (strategy.md approved by CJ).
- 2026-06-14 — CJ reigned in the profile: quality names only, no leveraged ETFs, no crypto, 7% risk/30% cap, 20% trailing stop.
- 2026-06-19 — rules.md created (was missing; extracted from CLAUDE.md active profile).
