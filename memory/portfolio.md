---
type: "memory"
file: "portfolio"
updated: "2026-06-19"
source: "Bull daily run — Juneteenth (markets closed)"
---

# Portfolio — Bull (Alpaca PAPER)

> Paper sandbox only. Separate from CJ's real Fidelity book.
> Alpaca API unreachable this session — egress to paper-api.alpaca.markets blocked by network policy. CJ: add this host to egress allowlist so Bull can place orders.

## Account Snapshot (last known: 2026-06-14; confirmed no trades through 2026-06-19)

| Field | Value |
|-------|-------|
| Equity | $100,000.00 |
| Cash | $100,000.00 |
| Buying Power | $100,000.00 |
| Open Positions | 0 |
| Day P&L | $0.00 (market closed — Juneteenth) |
| Month P&L (Jun) | $0.00 |
| vs SPY (inception) | ≈ −3.3% (SPY +3.3% since inception; Bull sat cash) |
| Regime | NEUTRAL (VIX 16.41, June 16 close) |

## Open Positions
None.

## Planned Trades (Queue for Monday June 22 open)

> Could NOT execute today: (1) Juneteenth — NYSE/NASDAQ closed. (2) Alpaca REST endpoint blocked by egress policy.
> On Monday, if Alpaca is accessible, place these as DAY LIMIT orders at open.

| Ticker | Side | Qty | Limit Price | Est Cost | % Equity | Trailing Stop | Thesis |
|--------|------|-----|------------|----------|----------|---------------|--------|
| AVGO | BUY | 54 | $411.35 | $22,213 | 22.2% | 18% (~$337) | AI custom chip leader; Q3 AI rev guided to $16B; $70B backlog; 6 hyperscaler customers; thesis intact post-Q2 |
| ANET | BUY | 133 | $168.24 | $22,376 | 22.4% | 18% (~$138) | AI data center networking leader; revenue +35% YoY; 2026 guidance raised to $11.5B; new 1.6T AI fabric platform |

### Sizing Verification (NEUTRAL regime, −25% trim)
- Risk budget: 7% × $100K = $7,000 per trade
- AVGO: formula → 94 shares (capped at 30% → 72; NEUTRAL trim → 54) | Actual risk: $3,998 (4.0%) ✓
- ANET: formula → 231 shares (capped at 30% → 178; NEUTRAL trim → 133) | Actual risk: $4,027 (4.0%) ✓
- Total deployed: $44,589 (44.6%) | Remaining cash: $55,411 (55.4%) ✓
- Technology sector: 44.6% (< 60% cap) ✓
- Open positions: 2 (< 8 cap) ✓

## Watchlist (candidates if Monday opportunity or positions fill poorly)
- **NVDA** $210.69 — momentum leader, up 2.95% June 18; hold back (adds to tech sector concentration)
- **MU** $1,142.92 — strong AI memory thesis; earnings June 24 (risky pre-earnings given last quarter's post-beat selloff); wait for post-earnings entry

## Circuit Breaker Status
- Daily halt trigger: −8% = −$8,000 → NAV $92,000 (NOT triggered: $0 P&L)
- Monthly kill trigger: −25% = −$25,000 → NAV $75,000 (NOT triggered: $0 MTD P&L)
- Status: CLEAR — new trades allowed Monday

## Action Required (CJ)
1. **Enable egress to `paper-api.alpaca.markets`** in remote environment network policy so Bull can place orders in future runs.
2. Review Monday trade plan (AVGO 54 shares, ANET 133 shares) and approve/modify before Monday open.
