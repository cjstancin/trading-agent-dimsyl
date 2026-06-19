---
type: "memory"
file: "portfolio"
updated: "2026-06-19"
source: "Bull daily run — last synced Alpaca 2026-06-14 (network egress blocked on 2026-06-19)"
---

# Paper Portfolio — Bull (Alpaca PAPER)

> **PAPER ONLY.** Alpaca paper account. Separate from CJ's Fidelity real book.

## Account Snapshot

| Field | Value |
|-------|-------|
| **Equity** | $100,000.00 |
| **Cash** | $100,000.00 |
| **Buying Power** | $400,000 (4× margin, unused) |
| **Day P&L** | $0 / 0% |
| **MTD P&L** | $0 / 0% |
| **vs S&P (MTD)** | ~−2.2% (Bull flat; SPY +2.2% since inception) |
| **As of** | 2026-06-14 (last confirmed Alpaca sync) |

> NOTE (2026-06-19): Network egress policy in the cloud run environment blocks `paper-api.alpaca.markets` and `finnhub.io`. Could not verify live account state. Assumes no change since last known state (2026-06-14). **CJ: Add those hosts to the environment's network egress allowlist to enable live sync.**

## Open Positions

*None — no trades placed yet.*

## Open Orders

*None.*

## Circuit-Breaker Status

| Check | Value | Status |
|-------|-------|--------|
| Daily P&L | 0% | ✅ Clear (halt at −8%) |
| MTD P&L | 0% | ✅ Clear (kill at −25%) |

## Pending Trade Plan (for Monday June 22, 2026)

| Ticker | Side | Qty | Limit | Stop | Cost | % Equity | Thesis |
|--------|------|-----|-------|------|------|----------|--------|
| NVDA | BUY | 137 | $191 | ~$153 (~20% trail) | ~$26,167 | 26.2% | AI chip king; momentum leader; 65% revenue growth; hyperscaler AI capex supercycle |
| AVGO | BUY WATCH | 64 | $408 | ~$326 (~20% trail) | ~$26,112 | 26.1% | Oversold 17% from $495 ATH; AI custom accelerator thesis intact (+106% AI revenue); Strong Buy consensus; WAIT for stabilization above $400 Monday AM |

*Market was closed June 19 (Juneteenth). Orders held for Monday open.*

## Sizing Check (Monday plan)

- Risk per trade: 7% × 75% neutral discount = 5.25% = $5,250
- Total deployment if both entered: $52,279 (52.3%)
- Cash after: $47,721 (47.7%) ✅ > 10% buffer
- Sector (tech): 52.3% ✅ < 60% cap
- Open positions: 2 ✅ < 8 cap
