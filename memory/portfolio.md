---
type: "memory"
file: "portfolio"
date: "2026-06-19"
summary: "Paper account snapshot. Alpaca unreachable today (network block). Markets closed — Juneteenth holiday."
---

# Portfolio — Bull (paper)

**Last synced:** 2026-06-19 (Juneteenth holiday — markets CLOSED. Alpaca unreachable from run environment.)
**Last verified Alpaca state:** 2026-06-14

## Account Summary

| Field | Value |
|-------|-------|
| Equity | ~$100,000 (last verified 2026-06-14; Alpaca blocked today) |
| Cash | ~$100,000 (100% cash, no open positions) |
| Buying Power | ~$100,000 |
| Open Positions | 0 |
| Day P&L | $0 / 0% |
| MTD P&L | $0 / 0% |
| vs SPY (since inception ~Jun 12) | ~ −2.5% (SPY +2.5% since inception; we are flat in cash) |
| vs SPY (YTD) | ~ −10.1% (SPY +10.09% YTD; we started paper account in June) |

## Open Positions
None — account has been entirely in cash since inception (June 12, 2026).

## Action Blockers (2026-06-19)
1. **Juneteenth holiday**: NYSE and Nasdaq CLOSED. Reopen Monday 2026-06-22.
2. **Alpaca network block**: `paper-api.alpaca.markets` is NOT in the run environment's egress allowlist. Cannot verify live account state or execute orders. **CJ must add `paper-api.alpaca.markets` to the remote execution environment's network egress settings to restore order execution.**

## Planned Trades for Monday 2026-06-22
(Conditional on: Alpaca network fix AND live prices near plan levels AND no circuit-breaker triggered)

### 1. SMH LONG — Semiconductor sector oversold snapback
- **Entry:** ~$659–$665 limit
- **Stop:** 20% trailing (~$527 at $660 entry)
- **Regime-adjusted sizing (NEUTRAL −25%):** 40 shares × $660 = $26,400 (26.4% of equity)
- **Thesis:** Semi sector was crushed June 5 (PHLX −10% on Broadcom guide miss vs $17.2B est; actual $16B). SMH fell −4.81% on June 17 then bounced +5.7% on June 18. VIX normalizing from 22 → 16.4. SMH still the YTD leader (+72.15%). Oversold snapback + sector momentum leader. Broadcom miss was single-name catalyst; AI demand intact (NVDA holding $200+, recovering).
- **Triggers met:** Momentum leader ✓ | Oversold snapback ✓ | Catalyst-resolved (guide miss priced in) ✓
- **Sector:** Tech/Semiconductors

### 2. AAPL LONG — Quality mega-cap tech, App Store momentum
- **Entry:** ~$297–$302 limit
- **Stop:** 20% trailing (~$238 at $298 entry)
- **Regime-adjusted sizing (NEUTRAL −25%):** 87 shares × $300 = $26,100 (26.1% of equity)
- **Thesis:** BofA Buy rating with $330 PT. App Store revenue +12% YoY (June 2026). iPhone upgrade cycle driven by Gen AI features. 48% gains past 12 months — durable momentum. Different risk profile from semis (consumer hardware + services mix). Closed June 18 at $298.01.
- **Triggers met:** Momentum leader ✓ | BofA catalyst (App Store data) ✓ | Quality large-cap ✓
- **Sector:** Information Technology

### Portfolio guardrail check (at plan levels)
| Check | Result |
|-------|--------|
| SMH position % | 26.4% ✓ (< 30%) |
| AAPL position % | 26.1% ✓ (< 30%) |
| Tech sector total | 52.5% ✓ (< 60%) |
| Open positions | 2 ✓ (< 8) |
| New this week | 2 ✓ (< 6) |
| Cash remaining | 47.5% ✓ (>> 10%) |
| Daily P&L halt | 0% → No halt ✓ |
| MTD kill-switch | 0% → No halt ✓ |

## Change Log
- 2026-06-14: Portfolio file initialized. $100K cash baseline established.
- 2026-06-19: No trades executed. Juneteenth holiday. Alpaca network blocked. Research complete; Monday plan drafted for SMH and AAPL.
