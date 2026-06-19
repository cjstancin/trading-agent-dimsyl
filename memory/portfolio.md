---
type: "memory"
file: "portfolio"
updated: "2026-06-19"
source: "status.json (last Alpaca sync: 2026-06-14). Alpaca API unreachable on 2026-06-19 run."
---

# Portfolio — Bull (paper)

## Account Snapshot
| Field | Value |
|-------|-------|
| Equity | $100,000.00 |
| Cash | $100,000.00 |
| Buying Power | ~$100,000 |
| Open Positions | 0 |
| Deployed | 0% |
| Cash Buffer | 100% |
| Day P&L | $0 (0.00%) |
| Month P&L (June) | $0 (0.00%) |
| vs S&P (inception) | -2.2% (SPY +2.2% since Jun 12, Bull flat) |

> Note: Alpaca API was unreachable on the 2026-06-19 run (network egress blocked). Values
> above are from the last known state (status.json, updated 2026-06-14). No confirmed sync today.

## Open Positions
*None.* All cash.

## Pending Intended Orders (could not be placed — Alpaca unreachable)
| Ticker | Side | Qty | Limit | Stop Type | Stop % | Thesis | Size % |
|--------|------|-----|-------|-----------|--------|--------|--------|
| ARM | BUY | 69 | $419.00 | Trailing | 18% | Breakout +5.69% today; AI chip design leader; momentum/breakout signal | 28.9% |
| ANET | BUY | 176 | $165.00 | Trailing | 18% | AI networking infra; 1.6T product launch catalyst; bullish technicals | 29.0% |

## Guardrail Check (if both orders fill)
- [x] ARM: 28.9% ≤ 30% ✓
- [x] ANET: 29.0% ≤ 30% ✓
- [x] Tech sector combined: 57.9% ≤ 60% ✓
- [x] Open positions: 2 of 8 max ✓
- [x] Cash remaining: 42.0% >> 10% buffer ✓
- [x] No margin ✓
- [x] Both stops set (18% trailing) ✓
- [x] Day halt not triggered (0% day P&L) ✓
- [x] Monthly kill not triggered (0% MTD P&L) ✓

## Circuit Breakers
- Day halt (−8%): NOT triggered (0% today).
- Monthly kill-switch (−25% MTD): NOT triggered (0% MTD).
- Regime: NEUTRAL (VIX ~16.4). Sizes trimmed ~25%.

## Watchlist
| Ticker | Note |
|--------|------|
| NVDA | -1.46% today — wait for better entry/consolidation |
| AVGO | Sector concentration full if ARM+ANET enter; monitor for rotation |
| SPY | Broad exposure hedge; watchlist if regime deteriorates |
| QQQ | Same — tech-weighted hedge option |
