# Bot Status — Alpaca paper (written by Bull each run)
# Mirrors what the dashboard publishes; quick text view of live paper state.

## ALPACA PAPER ACCOUNT · 2026-06-19
- Equity: ~$100,000 (last confirmed 2026-06-14; API blocked today)
- Cash / buying power: ~$100,000
- Open positions: 0 confirmed
- Day P&L: $0 | Week: $0 | Month (MTD): $0
- Regime: NEUTRAL (VIX ~16.4) | Last updated: 2026-06-19

## CIRCUIT BREAKERS
- Daily halt (−8%): CLEAR
- Monthly kill-switch (−25%): CLEAR

## PENDING TRADES (for June 22)
| Ticker | Side | Qty | Entry | Stop | Size |
|--------|------|-----|-------|------|------|
| MU | LONG | 23 | $1,140 | $912 | 26.2% |
| NVDA | LONG | 128 | $205 | $164 | 26.2% |

## ISSUES TO FIX
1. ⚠️ `paper-api.alpaca.markets` not in egress allowlist → add to network egress settings
2. ⚠️ `ALPACA_BASE_URL` already includes `/v2` suffix — REST calls must not double-prefix with `/v2/`
3. ℹ️ Market closed June 19 (Juneteenth) — next session Monday June 22

## NOTE
Paper sandbox only — separate from CJ's real Fidelity book (`memory/real-portfolio-fidelity.md`).
