---
type: "memory"
file: "portfolio"
updated: "2026-06-19 (Juneteenth — markets closed; Alpaca API unavailable, network egress blocked)"
---

# Paper Portfolio — Bull · 2026-06-19

> ⚠️ Live Alpaca API unavailable today — egress policy blocks paper-api.alpaca.markets and finnhub.io.
> All figures reflect last confirmed dashboard state (June 14) + known trade history (0 trades).
> Markets closed today (Juneteenth federal holiday). No orders can be placed.

## Account Summary (last confirmed + estimated)
| Field | Value | Note |
|-------|-------|------|
| Equity | $100,000 | Unchanged — all cash, no trades taken |
| Cash | $100,000 | All cash |
| Buying Power | $100,000 | No margin used |
| Open Positions | 0 | Verified via trade log |
| Open Orders | 0 | |
| Day P&L | $0 | Market closed (Juneteenth) |
| MTD P&L % | 0% | No trades placed yet |
| MTD P&L $ | $0 | |
| vs S&P (inception) | ~−7.4% est | SPY up ~7.4% since Jun 12; we're flat in cash |
| Regime | NEUTRAL | VIX ~16.4 (barely above 16 threshold) |

## Open Positions
_None._

## Open Orders
_None._

## Monday Watchlist (2026-06-23 — first open after Juneteenth)
Regime NEUTRAL → size 25% smaller than RISK-ON max. Confirm live prices at open before entry.

### #1 — SMH (Primary) · Semiconductor ETF Breakout
- **Entry:** ~$662 limit (last close $659.61; at 52-wk high breakout zone)
- **Stop:** 18% trailing (~$543 initial)
- **Thesis:** SMH hit 52-week high $660.84 intraday on June 18, closing at $659.61. "Strong Buy" signal. US-Iran ceasefire removed macro overhang; AI data center capex driving NVDA/AMD/AVGO components. Cleaner risk than single-name at same exposure.
- **Sizing (CLAUDE.md rules — 7% risk / 30% cap):**
  - Risk budget: 7% × $100,000 = $7,000
  - Risk/share (18% trail on $662): $662 − ($662 × 0.82) = $119.16
  - Raw shares: $7,000 ÷ $119.16 = 58.7 → **45 shares** (capped at 30%)
  - Cost: 45 × $662 = **$29,790 (29.8% of equity)** ✓
  - Trailing stop order: 18% GTC after fill

### #2 — NVDA (Secondary, add only after SMH confirmed filled) · AI Leader
- **Entry:** ~$207 limit (range June 18: $203–$209; stable AI infrastructure leader)
- **Stop:** 18% trailing (~$170 initial)
- **Thesis:** NVDA is the AI compute platform. Fundamentals remain intact despite mixed week. Wait for SMH fill before entering to avoid over-concentrating in semis before Monday open reveals tone.
- **Sizing:**
  - Risk/share: $207 − ($207 × 0.82) = $37.26
  - Raw shares: $7,000 ÷ $37.26 = 187.8 → **100 shares** (capped; sector check needed)
  - Cost: 100 × $207 = **$20,700 (20.7% of equity)** ✓
  - Sector total (SMH+NVDA): ~30% + ~21% = **51% semis/tech** — under 60% cap ✓

### Combined portfolio if both entered Monday:
| Position | Shares | Cost | % Equity |
|----------|--------|------|----------|
| SMH | 45 | $29,790 | 29.8% |
| NVDA | 100 | $20,700 | 20.7% |
| **Cash** | — | **$49,510** | **49.5%** |
- Sector: Tech/Semis ~50.5% ≤ 60% cap ✓
- Positions: 2 of max 8 ✓
- Cash buffer: 49.5% >> 10% minimum ✓

### Skip list (for Monday)
- **AMD**: Pulled back ~23% from ATH ($558 → ~$430); wait for stabilization base to form before re-entry.
- **AVGO**: $408 close; mixed momentum signals; watchlist pending SMH performance.
- **QQQ**: Secondary candidate if SMH position underperforms or for additional broad-tech exposure later.

## ⚠️ OPERATIONAL BLOCKS — Action Required Before Monday
1. **Alpaca API blocked (CRITICAL):** HTTP 403 "Host not in allowlist: paper-api.alpaca.markets". Add `paper-api.alpaca.markets` and `data.alpaca.markets` to the environment's network egress allowlist (Claude Code on Web settings). Without this, Bull cannot check account, manage positions, or place orders.
2. **Finnhub API blocked:** `finnhub.io` also returns 403. Add to egress allowlist for real-time quotes and news.
3. **⚠️ Paper API keys may need rotation:** A `curl -v` debug command on this run printed auth headers (APCA-API-KEY-ID and APCA-API-SECRET-KEY) in the terminal session transcript. Per CLAUDE.md rules, recommend rotating at https://alpaca.markets/app/paper/overview → Account → API Keys. (These are paper keys, not live — but good hygiene.)

## Circuit Breaker Status
| Check | Value | Status |
|-------|-------|--------|
| MTD P&L | $0 (0%) | ✅ Above −25% kill-switch |
| Day P&L | $0 | ✅ Above −8% halt |
| Kill switch | OFF | ✅ |
| Halt today | OFF | ✅ (market closed anyway) |
