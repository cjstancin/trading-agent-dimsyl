---
type: "memory"
file: "rules"
date: "2026-06-19"
summary: "Hard rules digest for Bull. Sourced from CLAUDE.md. CLAUDE.md wins on any conflict."
---

# Rules — Bull (paper) · Active Profile: AGGRESSIVE (QUALITY)

> Reigned in by CJ on 2026-06-14. CLAUDE.md is authoritative; this file is a run-time reference digest.

## Profile caps (CLAUDE.md wins over strategy.md on all conflicts)

| Rule | Value |
|------|-------|
| Risk per trade | 7% of equity |
| Sizing formula | `shares = (0.07 × equity) ÷ (entry − stop)` |
| Max position size | 30% of equity |
| Max sector | 60% of equity |
| Max open positions | 8 |
| Cash buffer | ≥ 10% |
| Margin | NONE |
| Trailing stop (default) | ~20% |
| Daily-loss halt | −8% of equity → no new entries |
| Monthly kill-switch | −25% MTD → STAND DOWN until CJ resumes |

## Universe (QUALITY ONLY)

**Allowed:** Liquid US large- and mid-cap stocks (real companies, real revenue) + liquid broad/sector ETFs (SPY, QQQ, XLK, SMH-type).

**Excluded:** Penny stocks (price < $10), leveraged/inverse ETFs (no SOXL/TQQQ/3×), crypto, meme/pump names, illiquid/no-volume, pre-revenue lottery tickets.

## Regime overlay (strategy.md)

| Regime | VIX | Action |
|--------|-----|--------|
| RISK-ON | < 16 | Full aggression |
| NEUTRAL | 16–24 | Trim new sizes 25%; be choosier |
| RISK-OFF | > 24 | High-conviction only; consider standing down |

## Hard rules (never break)

1. **Stop on every trade.** No naked positions.
2. **Never widen a stop unilaterally.** Propose changes in weekly review for CJ's approval.
3. **Log every trade with a one-line thesis.** Be honest — accountability, not cheerleading.
4. **Respect the daily halt and monthly kill-switch.**
5. **Keys from env vars only.** Never print or store a secret. If a key leaks, tell CJ to rotate it.
6. **Paper account only.** Never use a live endpoint. Live trading requires a written opt-in from CJ.

## Endpoint (PAPER ONLY)

`ALPACA_BASE_URL` must point to `https://paper-api.alpaca.markets/v2`. Never use a live endpoint.

## Exit rules

- **Stop:** ~20% trailing from entry (always set on order placement).
- **Cut:** Down −12% from entry → exit unless dated catalyst is imminent and thesis intact.
- **Thesis break:** Reason for entry is gone → exit regardless of P&L.
- **Time stop:** Dead money after ~2–3 weeks with no progress → recycle capital.
- **Scale:** Trim into strength at first target; let runner trail with tightened stop.

## Sizing check (run before every entry)

```
shares = (0.07 × equity) ÷ (entry − stop)
→ cap at 30% position
→ check sector ≤ 60%, ≤ 8 open, ≤ 6 new/week, ≥ 10% cash remaining
→ show: shares, cost, resulting %
```

In NEUTRAL regime, additionally multiply risk by 0.75 (size 25% smaller).

## Real-book awareness

CJ's real Fidelity book: ~$80K, ~76% AMD+MSFT, ~99% tech. Avoid adding paper positions that heavily mirror the real book's concentration (particularly AMD).
