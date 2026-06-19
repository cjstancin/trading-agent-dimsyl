---
type: "memory"
file: "portfolio"
account: "Alpaca PAPER"
last-updated: "2026-06-19"
note: "ALPACA API UNREACHABLE from remote run env — egress blocked. Values estimated from last known state (dashboard 2026-06-14) + no positions = equity unchanged."
---

# Portfolio — Bull (Alpaca PAPER)

> This is the PAPER sandbox account only. CJ's real money is at Fidelity (see real-portfolio-fidelity.md). Never conflate.

## Account Summary (estimated — Alpaca egress blocked 2026-06-19)
| Field | Value | Note |
|-------|-------|------|
| Equity | ~$100,000 | Last confirmed 2026-06-14; no positions so unchanged |
| Cash | ~$100,000 | Fully in cash, no open positions |
| Buying Power | ~$100,000 | No margin; buying power = cash |
| Day P&L | $0 | No positions |
| MTD P&L | $0 (0%) | No trades placed yet |
| vs S&P 500 MTD | ~−2.5% | SPY up ~+2.5% June MTD while flat in cash |

## Circuit Breaker Status
- Daily loss: $0 (0%) — CLEAR
- MTD loss: $0 (0%) — CLEAR
- Kill-switch threshold: −$30,000 (−30%) — FAR CLEAR

## Open Positions
| Ticker | Side | Qty | Entry | Stop | Current | Unrealized | Thesis |
|--------|------|-----|-------|------|---------|------------|--------|
| — | — | — | — | — | — | — | — |

*No open positions. Fully in paper cash.*

## Pending Orders (intended — could not place, Alpaca blocked)
See research-log.md 2026-06-19 for sizing analysis on AVGO, NVDA, AMD, SMH.
These should be placed on the NEXT run when Alpaca egress is unblocked.

## Open Orders on Alpaca
*Could not verify — API blocked. Assumed none (matching dashboard state).*

## Sector Exposure
| Sector | $ Exposure | % Equity |
|--------|------------|----------|
| Technology | $0 | 0% |
| Total | $0 | 0% |

## MTD Stats
- Trades closed: 0
- Wins: 0 | Losses: 0
- Win rate: N/A
- Realized P&L: $0
- Vs SPY MTD: approx −2.5% (cash drag vs SPY advance)

## History
| Date | Event |
|------|-------|
| 2026-06-12 | Account initialized, $100K paper cash, no trades |
| 2026-06-14 | Dashboard confirmed $100K equity, 0 positions, 0 trades |
| 2026-06-19 | Daily run — Alpaca API blocked by egress policy; no trades placed; 3 candidates identified |
