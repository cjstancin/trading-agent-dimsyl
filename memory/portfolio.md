---
type: "memory"
file: "portfolio"
date: "2026-06-19"
updated: "2026-06-19 ~14:00 UTC (daily run)"
---

# Portfolio — Bull (Alpaca PAPER) · 2026-06-19

> PAPER account only. Separate from CJ's real Fidelity book (see `real-portfolio-fidelity.md`).
> ⚠️ NOTE: Alpaca paper API (`paper-api.alpaca.markets`) is blocked by network egress policy today.
> Last confirmed equity was $100,000 as of 2026-06-14. No trades have been executed yet.

## Account Snapshot
| Field | Value |
|-------|-------|
| Equity | ~$100,000 (last confirmed 2026-06-14; API blocked) |
| Cash | ~$100,000 |
| Buying Power | ~$100,000 (no margin) |
| Day P&L | $0 (no open positions) |
| MTD P&L | $0 (0.0%) |
| vs SPY since inception | −3.0% (paper flat; SPY ~+3% since June 12) |

## Open Positions (Confirmed on Alpaca)
**NONE** — No positions confirmed. API blocked by network egress; market also closed (Juneteenth).

## Pending / Intended Trades (for June 22 open)
These were sized and screened today but could not be executed due to network egress blocking Alpaca and the June 19 Juneteenth market holiday. Orders should be entered as GTC limits on Monday June 22.

| Ticker | Side | Qty | Limit Entry | Stop | Est. Cost | % Equity | Conviction |
|--------|------|-----|-------------|------|-----------|----------|------------|
| MU | LONG | 23 | $1,140 | $912 (20% trail) | $26,220 | 26.2% | HIGH |
| NVDA | LONG | 128 | $205 | $164 (20% trail) | $26,240 | 26.2% | MEDIUM |

### MU Thesis
Pre-earnings catalyst June 24: Micron Q3 FY2026 earnings — AI HBM memory sold out all of 2026, Wall Street expects 960% EPS growth YoY. Analyst upgrades before Juneteenth holiday: Stifel $1,500, Wedbush $1,300, Deutsche Bank $1,500, TD Cowen $1,500. Stock closed at ATH ~$1,140 (+8% on June 18). 2+ strategy triggers: breakout at ATH, momentum leader, near-term dated catalyst.

### NVDA Thesis
AI GPU infrastructure secular leader. Blackwell driving 85% YoY revenue ($81.6B last quarter). Vera Rubin next-gen accelerator on track for H2 2026. 95% analyst buy consensus; $275 average target (34% upside from ~$205). Pulled back from $232 resistance — re-entry into trend. 2+ strategy triggers: momentum leader, catalyst (Vera Rubin H2 2026).

## Guardrail Check (Pre-Trade)
- [x] Each position ≤ 30%: MU 26.2%, NVDA 26.2% ✓
- [x] Sector ≤ 60%: Tech/Semis combined 52.4% ✓
- [x] ≤ 8 open, ≤ 6 new this week: 2 intended ✓
- [x] Cash buffer ≥ 10%: $47,540 remaining (47.5%) after intended trades ✓
- [x] Daily halt: MTD/Day P&L both $0 — clear ✓
- [x] Regime NEUTRAL (VIX 16.4) → sizes trimmed ~25% from full-aggression ✓
- [x] Stop on every entry ✓
- [x] Price > $10: MU ~$1,140, NVDA ~$205 ✓
- [x] No leveraged ETFs, no crypto ✓

## Sizing Work (shown for transparency)
Regime = NEUTRAL (VIX 16.4) → risk budget per trade: 7% × 0.75 = 5.25% of equity = $5,250

**MU:** entry $1,140, stop $912, risk/share $228. Shares = $5,250/$228 = 23.0 → 23 shares. Value = $26,220.
**NVDA:** entry $205, stop $164, risk/share $41. Shares = $5,250/$41 = 128.0 → 128 shares. Value = $26,240.

## Circuit Breakers
| Check | Status |
|-------|--------|
| Daily halt (−8%) | CLEAR — $0 loss |
| Monthly kill-switch (−25% MTD) | CLEAR — $0 MTD |
| Regime | NEUTRAL (VIX ~16.4) |

## Action Required
1. **Fix network egress**: Add `paper-api.alpaca.markets` to the allowed egress list so Bull can trade.
2. **Manual fallback**: If egress can't be fixed before June 22 open, CJ can manually enter MU and NVDA limit orders in the Alpaca paper dashboard.
3. **Also note**: ALPACA_BASE_URL already contains `/v2` — the REST helper script should strip any extra `/v2/` prefix to avoid double-pathing.
