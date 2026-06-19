# Research Log — Bull (paper)
# Dated notes appended each run.

---

## 2026-06-19 (Juneteenth — market holiday)

**Regime:** NEUTRAL — VIX ~16.2 (closed 16.41 on June 16, opened ~16.19 June 19). Just above the 16 RISK-ON threshold. Per strategy: trim new sizes 25%, be choosier. Full aggression available ≥RISK-ON at VIX <16.

**Market context:**
- S&P 500 ~7,600, near all-time highs. Nine-week rally briefly interrupted by a sharp selloff, then recovered on Iran war-end hopes.
- AI capex supercycle intact: hyperscalers committed $750B in 2026 capex; NVDA fiscal 2026 revenue $215.9B (+65% YoY).
- Semiconductors (SOXX) plunged ~10% last week then rebounded sharply on renewed AI infra confidence and index re-balancing.
- Geopolitical tailwind: Iran peace talks boosting risk sentiment on June 12+.

**Sector leaders:**
- AI/Semis: NVDA, AMD, AVGO, MU all outperforming; XLK/SMH-type ETFs strong.
- Memory: MU at ~$1,043, up 703% past year on AI memory demand.
- AVGO at $408 (June 18 close), down 17% from $495 ATH (June 3). Broke below $410 support — watch for stabilization.

**Watchlist for Monday June 22:**

| Ticker | Price (6/18) | Signal | Entry thesis |
|--------|-------------|--------|-------------|
| NVDA | ~$189 | Momentum leader + catalyst | AI chip king; 65% revenue growth; ongoing hyperscaler capex. 2+ triggers. |
| AVGO | $408.24 | Oversold snapback candidate | 17% off ATH, AI accelerator thesis intact. WAIT: broke $410 support — confirm stabilization above $400 Monday AM before buying. |
| AMD | $512.48 | Momentum leader | 130% YTD. NOTE: CJ has AMD heavily in real Fidelity book — skip or size small to avoid doubling up on correlation. |
| MU | $1,043.19 | Momentum | 703% past year — very extended. Consider on pullback or skip for now. |
| QQQ | ~$520-530 est. | Broad tech ETF | Alternative broad tech exposure; use if individual names too rich. |

**Infrastructure issues (ACTION NEEDED — CJ):**
1. `paper-api.alpaca.markets` is NOT in the cloud run environment's network egress allowlist. Bull cannot verify account state or place paper trades until this is added.
2. `finnhub.io` is also blocked by the same egress policy.
3. Fix: Go to your Claude Code Remote environment settings → Network → Egress, add both hosts. Alternatively, run Bull locally where these are reachable.

**Circuit breakers:** None triggered. MTD = 0%, daily = 0%.

**Approved cycle:** No analyst-approved trades in Signals/approved-cycle.md. Self-sourcing per strategy.md.
