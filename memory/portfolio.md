---
type: "memory"
file: "portfolio"
updated: "2026-06-19 05:05 UTC"
source: "Bull daily run — Alpaca PAPER"
---

# Portfolio — Bull (Alpaca PAPER)

> Paper sandbox only. Separate from CJ's real Fidelity book. Never conflate.

## ACCOUNT SUMMARY — 2026-06-19 05:05 UTC

| Field | Value |
|-------|-------|
| Equity | $100,000.00 |
| Cash / Buying Power | $100,000.00 (100%) |
| Open Positions | 0 |
| Open Orders | 0 |
| Day P&L | $0.00 (0%) — market closed (Juneteenth) |
| Month-to-Date P&L | $0.00 (0%) |
| vs S&P 500 (inception) | **−3.9%** (SPY up ~3.9% since account creation; we are all-cash) |

**NOTE — Execution Blocked:** Network egress policy blocks `paper-api.alpaca.markets`.
Trades are researched and staged but NOT yet placed on Alpaca. CJ must either:
- Add `paper-api.alpaca.markets` to the environment's network egress allowlist, OR
- Place the staged trades manually on the Alpaca paper dashboard.

**NOTE — Market Closed:** June 19 is Juneteenth (US federal holiday). Next trading day: **Monday June 22, 2026**.

---

## OPEN POSITIONS

None. All cash since account inception.

---

## OPEN ORDERS

None. (See staged trade plan below — cannot be placed until Alpaca network access is restored.)

---

## STAGED TRADE PLAN — Execute at Monday June 22 open

Regime: **NEUTRAL** (VIX ~17.4 — between 16–24). Sizes trimmed ~25% per NEUTRAL rule.

### Trade 1: NVDA (NVIDIA Corporation)
- **Action:** BUY LONG
- **Entry limit:** $210.50
- **Qty:** 124 shares
- **Cost:** ~$26,102 (26.1% of equity)
- **Trailing stop:** 20% (~$168.40 initial level)
- **First target:** $275 (analyst avg consensus)
- **Risk budget:** $7,000 × 0.75 NEUTRAL = $5,250 | Risk/share = $42.10
- **Thesis:** AI infrastructure leader; Q1 FY27 rev +85% YoY ($81.6B); trading at the floor of analyst target range ($210 low, $275 avg, $360 high); $25B debt raise to fund Blackwell/Rubin buildout; $1T cumulative demand forecast by end 2027. Entered near strong support.

### Trade 2: AVGO (Broadcom Inc.)
- **Action:** BUY LONG
- **Entry limit:** $408.00
- **Qty:** 64 shares
- **Cost:** ~$26,112 (26.1% of equity)
- **Trailing stop:** 20% (~$326.40 initial level)
- **First target:** $522 (analyst avg consensus, +28% upside)
- **Risk budget:** $5,250 NEUTRAL trim | Risk/share = $81.60
- **Thesis:** AI custom silicon leader; AI rev doubled YoY Q2 ($10.8B); guides Q3 AI rev to $16B (nearly 3x); >$100B AI semi rev by FY27; 6 hyperscaler chip customers (Google, Meta, OpenAI, Anthropic). Pulled back from all-time high on software guidance miss June 3; AI story intact and accelerating.

### Guardrail Check (pre-execution)
- [x] Each position ≤ 30%: NVDA 26.1%, AVGO 26.1% ✓
- [x] Sector (Semiconductors): 26.1% + 26.1% = 52.2% ≤ 60% ✓
- [x] Open positions after: 2 ≤ 8 ✓
- [x] New trades this week: 2 ≤ 6 ✓
- [x] Cash after: ~$47,786 ≥ 10% ($10,000) ✓
- [x] No margin used ✓
- [x] Stop on every entry ✓
- [x] Daily P&L: $0 (no halt) ✓
- [x] MTD P&L: $0 (no kill-switch) ✓

### Skipped / Watching
- **AMD** — watching only. CJ already has heavy real-portfolio AMD exposure (~76% of real book in AMD+MSFT). AMD at $531 is also near ATH ($558 June 15); chasing near ATH in NEUTRAL regime with CJ already long = lower priority.
- **MSFT** — monitoring. Part of CJ's real portfolio; not enough distinct catalyst vs. NVDA/AVGO for the paper sandbox.

---

## CIRCUIT BREAKER STATUS

| Check | Value | Limit | Status |
|-------|-------|-------|--------|
| Today P&L | $0 (0%) | −8% halt | ✓ CLEAR |
| MTD P&L | $0 (0%) | −25% kill | ✓ CLEAR |
| Peak equity | $100,000 | — | — |
| Max drawdown | 0% | 20% target | ✓ CLEAR |

---

## PERFORMANCE LOG

| Date | Equity | Day P&L | MTD P&L | vs SPY |
|------|--------|---------|---------|--------|
| 2026-06-14 | $100,000 | $0 | $0 | −2.2% |
| 2026-06-19 | $100,000 | $0 | $0 | −3.9% (est.) |
