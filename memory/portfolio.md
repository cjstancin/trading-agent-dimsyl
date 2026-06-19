---
type: "memory"
file: "portfolio"
date: "2026-06-19"
source: "Alpaca PAPER (API unreachable this run) + web research"
summary: "Bull paper account state. All USD. Updated each run. Alpaca data is last confirmed 2026-06-14."
---

# Portfolio — Bull (paper) · 2026-06-19

> **RUN BLOCKER — ALPACA UNREACHABLE:** `paper-api.alpaca.markets` is not in the network egress allowlist for this execution environment (HTTP 403). Equity and positions reflect the last confirmed state: 2026-06-14 seed of $100,000, 0 open positions. Planned orders documented below — **cannot execute until egress is permitted.**
>
> **MARKET STATUS:** June 19 = Juneteenth (US Federal Holiday). NYSE is CLOSED. Even with API access, no orders would fill today. Next trading day: **Monday June 22, 2026.**

---

## Account Snapshot (last confirmed 2026-06-14)

| Field | Value |
|-------|-------|
| **Equity** | $100,000 |
| **Cash** | $100,000 |
| **Buying Power** | $100,000 |
| **Open Positions** | 0 |
| **Open Orders** | 0 |
| **Day P&L** | $0 (0.00%) |
| **MTD P&L (June)** | $0 (0.00%) |
| **vs S&P 500 (inception)** | −3.8% (held cash while SPY rose ~3.8% since inception) |

---

## Market Regime — 2026-06-19

| Indicator | Reading | Signal |
|-----------|---------|--------|
| VIX | 16.41 | **NEUTRAL** (16–24 band, low end) |
| Regime | **NEUTRAL** | Trim new position sizes ~25%; be choosier on entries |
| SPY last close | $746.74 (Jun 18) | Near multi-week highs |
| QQQ open | ~$735 | Tech holding strength |
| May CPI | 4.2% | Hotter-than-target; no near-term Fed cuts |
| Geopolitics | Iran peace MOU in progress | Oil prices easing; mild tailwind |

---

## Circuit Breakers

| Check | Value | Threshold | Status |
|-------|-------|-----------|--------|
| MTD P&L | 0% | −25% kill-switch | ✅ CLEAR |
| Day P&L | 0% | −8% halt | ✅ CLEAR |
| Monthly kill-switch | NOT triggered | — | ✅ Trading AUTHORIZED |

---

## Open Positions

*None.*

---

## Planned Orders — Target: Mon June 22, 2026 (market open)

Sizing: `shares = (0.07 × $100,000) ÷ (entry − stop)`, capped at 30% per position, then trimmed ~25% for NEUTRAL regime.

| Ticker | Side | Qty | Limit Entry | Stop (18% trailing) | Est. Cost | % Equity | Thesis (1 line) |
|--------|------|-----|-------------|----------------------|-----------|----------|-----------------|
| NVDA | BUY | 107 | $210.00 | ~$172.20 | $22,470 | 22.5% | AI momentum leader; breakout on above-avg volume (241M vs 161M avg); strongest AI infrastructure play |
| MSFT | BUY | 56 | $396.00 | ~$324.72 | $22,176 | 22.2% | Quality AI/cloud compounder; Copilot monetization; consolidating near highs — lower-risk add |
| QQQ | BUY | 30 | $735.00 | ~$602.70 | $22,050 | 22.1% | Broad tech exposure; diversifies semiconductor concentration; liquid, low-maintenance |

**Post-entry totals (if all fill):**
- Total deployed: $66,696 (66.7%)
- Cash remaining: $33,304 (33.3%) ← well above 10% buffer ✅
- Tech individual stocks (NVDA + MSFT): 44.7% ← under 60% sector cap ✅
- Positions open: 3 of max 8 ✅
- Stop on every planned entry ✅

---

## Holdings Considered and Skipped

| Ticker | Decision | Reason |
|--------|----------|--------|
| AVGO | Skip for now | RSI 75.32 — overbought; late-stage breakout; watching for a pullback entry |
| AMD | Skip | CJ holds 70 shares (~$38K market value) in real Fidelity account; avoiding paper-doubling a name CJ is already 45% concentrated in |
| INTC | Skip | Breakout noted but second-tier AI thesis vs NVDA; prefer the leader |
| SOXL / TQQQ | Excluded | Leveraged ETFs permanently excluded per CLAUDE.md (overrides strategy.md reference) |
| Crypto | Excluded | Excluded per CLAUDE.md in all regimes |

---

## Action Required — CJ / System Admin

1. **Add `paper-api.alpaca.markets` to the network egress allowlist** so Bull can place orders and read live account state.
2. On next run (Mon June 22 or whenever egress is fixed), Bull will execute the planned orders above, verify fills, and set trailing stops.
