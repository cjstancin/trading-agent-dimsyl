---
type: "memory"
file: "portfolio"
updated: "2026-06-19"
source: "Alpaca PAPER (last confirmed 2026-06-14; API unreachable 2026-06-19 — egress blocked)"
---

# Paper Portfolio — Bull

> Alpaca PAPER account only. Real Fidelity holdings are in real-portfolio-fidelity.md — not touched here.

## Account Snapshot (last confirmed: 2026-06-14)

| Field | Value |
|-------|-------|
| Equity | $100,000.00 |
| Cash | $100,000.00 |
| Buying Power | $100,000.00 |
| Open Positions | 0 |
| MTD P&L | $0 / 0.00% |
| YTD P&L | $0 / 0.00% |
| vs S&P 500 | −2.2% (SPY up ~2.2% from our starting baseline; we are flat) |

> **2026-06-19 NOTE:** Alpaca REST API (`paper-api.alpaca.markets`) was unreachable on this run — blocked by cloud egress policy. Figures above reflect the last confirmed state (2026-06-14). No live equity refresh was possible.

## Open Positions

_None_

## Pending / Watchlist

| Ticker | Direction | Entry Target | Stop | Target | Size | Thesis | Confidence |
|--------|-----------|-------------|------|--------|------|--------|-----------|
| MRVL | LONG | ~$325 | 18% trail (~$267) | $345 | ~91 sh / ~$29.6k (29.6%) | S&P 500 inclusion June 22 forced buying; AI chip demand secular tailwind; B. Riley target $345 | HIGH — dated catalyst + momentum |

> MRVL sizing is NEUTRAL-adjusted (−25%): 7% × 75% = 5.25% risk on $100k = $5,250 / ($325-$267) = ~91 shares. Under 30% cap ✓. Sector: Tech.
> NOTE: CJ is already heavily tech-concentrated in Fidelity (AMD ~45%, MSFT ~31%). Acknowledge but do not override paper strategy.

## Circuit Breakers

| Check | Status |
|-------|--------|
| MTD P&L ≤ −25% → STAND DOWN | Clear (MTD = $0) |
| Daily P&L ≤ −8% → halt new entries | Clear (day = $0) |
| Positions ≤ 8 open | Clear (0 open) |
| Cash buffer ≥ 10% | Clear (100% cash) |

## Stats (cumulative)

| Metric | Value |
|--------|-------|
| Total trades | 0 |
| Win rate | — |
| Profit factor | — |
| Max drawdown | 0% |
