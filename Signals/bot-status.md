# Bot Status — Alpaca paper (written by Bull each run)
# Mirrors what the dashboard publishes; quick text view of live paper state.

## ALPACA PAPER ACCOUNT — 2026-06-19

- Equity: $100,000.00 (last live fetch: June 14 — Alpaca API unreachable from cloud env)
- Cash / buying power: $100,000.00
- Open positions: 0
- Day P&L: $0.00 (0.00%) | Week: N/A | Month (MTD): $0.00 (0.00%)
- vs S&P (since inception): ~ −3.5% (SPY YTD +10.09%; paper flat)
- Regime: **NEUTRAL** — VIX 16.41

## Trade proposals (researched, NOT yet executed)

| Ticker | Side | Qty | Entry | Stop | Status |
|--------|------|-----|-------|------|--------|
| NVDA | LONG | 107 | ~$210.33 | 18% trail (~$172) | PENDING — Alpaca blocked |
| QQQ | LONG | 30 | ~$744.00 | 18% trail (~$610) | PENDING — Alpaca blocked |

## Circuit breakers

- Daily halt (−8%): NOT TRIGGERED
- Monthly kill (−25% MTD): NOT TRIGGERED
- Regime: NEUTRAL → 25% size reduction on new entries

## Connectivity alert

paper-api.alpaca.markets is NOT in the cloud egress allowlist.
Bull cannot place orders or fetch live account data from this environment.
Action required: add Alpaca API to egress settings (Claude Code on the web → Environment settings).

## NOTE

Paper sandbox only — separate from CJ's real Fidelity book (memory/real-portfolio-fidelity.md).
