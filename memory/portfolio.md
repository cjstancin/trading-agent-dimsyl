---
type: "memory"
file: "portfolio"
date: "2026-06-19"
summary: "Paper account state — updated each run. PAPER ONLY, separate from CJ's Fidelity real book."
---

# Portfolio — Bull (paper)

> Alpaca PAPER account only. Endpoint: `https://paper-api.alpaca.markets`. Separate from CJ's real Fidelity book.

## Account Status — 2026-06-19

| Field | Value | Notes |
|-------|-------|-------|
| Equity | **$100,000.00** | Starting capital — no trades executed yet |
| Cash | **$100,000.00** | Fully liquid |
| Buying Power | **$100,000.00** | No margin; estimated (API blocked this run) |
| Day P&L | $0.00 (0.00%) | Juneteenth — US markets closed |
| MTD P&L | $0.00 (0.00%) | No trades placed since inception Jun 12 |
| vs S&P 500 (inception) | **≈ −1.1%** | SPY +~1.1% since Jun 12 inception; paper flat |

### API Connectivity — BLOCKED
Alpaca REST API returned HTTP 403 "Host not in allowlist" this run.
- Host: `paper-api.alpaca.markets` not in cloud egress allowlist.
- **Required action for CJ:** Add `paper-api.alpaca.markets` and `data.alpaca.markets` to network egress settings at [code.claude.com/docs](https://code.claude.com/docs/en/claude-code-on-the-web).
- Until resolved: no automated order placement from cloud runs. Research + staging only.

## Open Positions (0)

*No open positions.*

## Open Orders (0)

*No orders placed — markets closed (Juneteenth) + API blocked.*

## Staged Trades for Monday June 22 Open

> STATUS: INTENTIONS ONLY — cannot execute until API unblocked. Re-evaluate prices at Monday open.

| # | Ticker | Side | Qty | Limit | Trailing Stop | Est. Cost | % Equity | Thesis |
|---|--------|------|-----|-------|---------------|-----------|----------|--------|
| 1 | NVDA | LONG | 107 | $209.50 | 18% | $22,417 | 22.4% | AI/PC momentum leader; above-avg volume Jun 19; RTX Spark Superchip (Dell/Lenovo partnerships) |
| 2 | SMH | LONG | 34 | $658.00 | 18% | $22,372 | 22.4% | Semi sector ETF leadership; Intel/Apple chip deal + AMD Helios pipeline = sector tailwind |

**Post-fill projection (if both fill):**
- Total deployed: ~$44,789 (44.8%)
- Cash remaining: ~$55,211 (55.2%) — well above 10% buffer ✓
- Sector concentration: ~44.8% tech/semiconductor (< 60% cap) ✓
- Positions open: 2 (< 8 cap) ✓

**Sizing math (NVDA):** 7% × $100k = $7,000 risk. Entry $209.50, stop $171.79 (18% trail implied). Risk/share = $37.71. Uncapped shares = 185 → 30% cap = 143 → NEUTRAL trim 25% = **107 shares**. Risk = $4,035 (4.0% actual, under 7% cap due to position cap).

**Sizing math (SMH):** 7% × $100k = $7,000 risk. Entry $658.00, stop $539.56 (18% trail implied). Risk/share = $118.44. Uncapped shares = 59 → 30% cap = 45 → NEUTRAL trim 25% = **34 shares**. Risk = $4,027 (4.0% actual).

## Circuit Breakers
- Day halt (−8%): **CLEAR** ($0 / 0%)
- Monthly kill (−25%): **CLEAR** ($0 / 0%)

## Regime at Run Time
**NEUTRAL** — VIX ~16.41 (Jun 16–18 reading), Fed held at 3.50–3.75% with hawkish dot plot.
Applying: ~25% size trim on new entries; be choosier about setups.

## Benchmark (SPY)
| Date | SPY Price | Index (100 = Jun 12) |
|------|-----------|----------------------|
| 2026-06-12 (inception) | ~$739 | 100.0 |
| 2026-06-18 (last close) | $746.74 | ~101.0 |

## Performance Summary
| Period | Paper P&L | SPY Return | Alpha |
|--------|-----------|------------|-------|
| Today | 0.0% | 0% (closed) | — |
| MTD (Jun) | 0.0% | +~1.0% | −1.0% |
| Since inception (Jun 12) | 0.0% | +~1.1% | −1.1% |

## Change Log
- 2026-06-19 — File CREATED. Account $100k, 0 positions, 0 trades. API blocked; Juneteenth closure. Trades staged for Monday.
