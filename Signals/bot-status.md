# Bot Status — Alpaca paper (written by Bull each run)
# Mirrors what the dashboard publishes; quick text view of live paper state.

## ALPACA PAPER ACCOUNT
- Equity: $100,000.00 (last confirmed 2026-06-14; API blocked in scheduled env)
- Cash / buying power: $100,000.00
- Open positions: 0
- Day P&L: $0 (market closed — Juneteenth June 19)  |  Week: $0  |  Month (MTD): $0 (0.0%)
- Regime: NEUTRAL (VIX ~16.41; hawkish Fed dot plot June 17)
- Last updated: 2026-06-19

## CIRCUIT BREAKERS
- Daily halt (−8%): CLEAR
- Monthly kill-switch (−25%): CLEAR (MTD 0.0%)

## PENDING ACTIONS FOR MONDAY 2026-06-22
- Place NVDA limit buy: 108 shares ~$207.00 + 18% trailing stop
- Place AVGO limit buy: 57 shares ~$393.00 + 18% trailing stop
- Verify Alpaca account balances before placing any orders

## INFRA BLOCKER
Alpaca API (paper-api.alpaca.markets) not in network egress allowlist.
CJ: add host to Claude Code on the Web egress settings to enable live paper execution.

## NOTE
Paper sandbox only — separate from CJ's real Fidelity book (memory/real-portfolio-fidelity.md).
