---
type: "memory"
file: "portfolio"
updated: "2026-06-19"
note: "Alpaca API unreachable from cloud execution environment (paper-api.alpaca.markets not in egress allowlist). Last live Alpaca data: 2026-06-14. Equity/cash unchanged from starting balance — no trades executed."
---

# Paper Portfolio — Bull

> PAPER ONLY. Separate from CJ's real Fidelity book (real-portfolio-fidelity.md).
> Alpaca endpoint: https://paper-api.alpaca.markets

## Account summary (as of 2026-06-19)

| Field | Value | Source |
|-------|-------|--------|
| Equity | $100,000.00 | Last known (June 14); Alpaca API blocked |
| Cash | $100,000.00 | Last known (June 14); no trades executed |
| Buying Power | $100,000.00 | |
| Open Positions | 0 | Confirmed by dashboard/data/status.json |
| Day P&L | $0.00 | 0.00% |
| MTD P&L | $0.00 | 0.00% |
| YTD P&L | $0.00 | 0.00% |
| vs S&P (since inception) | ~ −3.5% | SPY ~+3.5% since account inception; paper flat |

## Circuit breaker status

- Daily halt (−8%): NOT TRIGGERED — P&L $0.00
- Monthly kill-switch (−25% MTD): NOT TRIGGERED — MTD $0.00

## Open positions

None. Account fully in cash.

## Regime

**NEUTRAL** — VIX 16.41 (June 19, 2026). Trim new sizes ~25%, be choosier.

## Pending trade proposals (blocked — Alpaca unreachable)

The following were researched and sized on 2026-06-19 but could NOT be executed. CJ should authorize Alpaca egress to enable live paper trading.

### Proposal 1: NVDA LONG
- Entry target: ~$210.33
- Stop: 18% trailing (~$172 initial)
- Sized shares: 107 (7% risk × $100k ÷ $38.33 spread → 182 raw → 142 capped at 30% → 107 after 25% NEUTRAL trim)
- Cost: ~$22,505 (~22.5% of equity) ✓
- Sector: Technology ✓ (22.5% of 60% cap used)
- Thesis: AI infrastructure spend robust (NVDA rev +85% YoY), oversold snapback from June 5 chip selloff, weekly bull flag with $300 analyst target; prediction market 64% chance of closing >$216 in June

### Proposal 2: QQQ LONG
- Entry target: ~$744.00
- Stop: 18% trailing (~$610 initial)
- Sized shares: 30 (7% risk × $100k ÷ $134 spread → 52 raw → 40 capped at 30% → 30 after 25% NEUTRAL trim)
- Cost: ~$22,320 (~22.3% of equity) ✓
- Sector: Technology (broad) ✓ (combined with NVDA: 44.8% vs 60% cap ✓)
- Thesis: QQQ +11% in 30 days; Nasdaq 100 at record high; US-Iran ceasefire removes tail risk; strong tech earnings cycle

### Combined check if both executed
| Check | Value | Limit | Pass |
|-------|-------|-------|------|
| NVDA position | 22.5% | 30% | ✓ |
| QQQ position | 22.3% | 30% | ✓ |
| Tech sector total | 44.8% | 60% | ✓ |
| Open positions | 2 | 8 | ✓ |
| Cash remaining | 55.2% | ≥10% | ✓ |
| Daily halt | Not triggered | | ✓ |
| Monthly kill | Not triggered | | ✓ |

## Connectivity issue (action required)

paper-api.alpaca.markets must be added to the cloud execution environment's egress allowlist before Bull can:
- Fetch live account/position data
- Place, modify, or close orders

Until fixed, this routine runs in research-only mode.
