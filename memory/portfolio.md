---
type: "memory"
file: "portfolio"
date: "2026-06-19"
updated: "2026-06-19 (daily run)"
summary: "Bull paper account snapshot. Alpaca PAPER only."
---

# Portfolio — Bull (Alpaca PAPER)

> Updated each run. Source: Alpaca PAPER account (via REST) + web research.
> **OPERATIONAL NOTE**: Alpaca REST API (`paper-api.alpaca.markets`) is blocked by network egress policy in the cloud execution environment. Finnhub also blocked. CJ must add these hosts to the egress allowlist for Bull to execute orders autonomously. Until then, queued trades must be placed manually via Alpaca web dashboard.

## As of 2026-06-19 (Juneteenth — markets closed)

| Field | Value |
|-------|-------|
| Equity | $100,000 (paper — no change; no trades executed) |
| Cash | $100,000 |
| Buying Power | $100,000 |
| Open Positions | 0 |
| Day P&L | $0 (0.00%) |
| MTD P&L | $0 (0.00%) |
| YTD P&L | $0 (0.00%) |
| vs SPY MTD | ~−1.5% est (SPY +~1.5% MTD, Bull flat) |
| Regime | NEUTRAL (VIX ~16.4) |

## Open Positions
None.

## Queued Orders — execute Monday June 22, 2026
> Manual entry required via Alpaca dashboard (or once API egress is fixed). Place as GTC limit orders with 20% trailing stops as separate orders.

| Ticker | Side | Qty | Limit Price | Stop Trigger | % Equity | Cost est. |
|--------|------|-----|-------------|--------------|----------|-----------|
| MU | BUY | 18 | $1,110 | 20% trailing (~$888 initial) | 20.0% | $19,980 |
| INTC | BUY | 163 | $122 | 20% trailing (~$97.60 initial) | 19.9% | $19,886 |
| ANET | BUY | 121 | $165 | 20% trailing (~$132 initial) | 20.0% | $19,965 |

**Totals if all fill**: ~$59,831 deployed (59.8%), ~$40,169 cash (40.2%)

## Pre-Order Guardrail Check
- [x] Each position ≤30% of equity (all at 20%)
- [x] Semiconductor sector MU+INTC ≤60% (39.9%)
- [x] IT sector total (all 3 names) ≤60% (59.8% — at cap)
- [x] ≤8 open positions (3 planned)
- [x] ≤6 new this week (3 planned, first week)
- [x] ≥10% cash buffer (40% cash if all fill)
- [x] No margin
- [x] Daily halt not triggered ($0 day P&L vs −8% threshold)
- [x] Monthly kill-switch not triggered ($0 MTD vs −25% threshold)
- [x] Stop on every entry (20% trailing each)

## Why These Three (not AMD or NVDA)
CJ's real Fidelity portfolio is ~$80K with AMD ~45% ($36K) and MSFT ~31%. Paper account deliberately explores names CJ doesn't own heavily so the learning and P&L data is maximally useful. NVDA also considered but MU/INTC/ANET offer complementary exposure with near-term catalysts.
