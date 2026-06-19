# Bot Status — Alpaca paper (written by Bull each run)
# Mirrors what the dashboard publishes; quick text view of live paper state.

## ALPACA PAPER ACCOUNT
- Equity: $100,000 (last-known; API blocked in run env — see BLOCKER below)
- Cash / buying power: $100,000
- Open positions: 0 (fully in cash)
- Day P&L: $0 (0.00%) | MTD: $0 (0.00%)
- vs S&P since inception: −2.4% (SPY up while we're in cash)
- Regime: NEUTRAL (VIX ~16.4) | Last updated: 2026-06-19

## BLOCKER — ACTION REQUIRED FOR CJ
`paper-api.alpaca.markets`, `data.alpaca.markets`, and `finnhub.io` are all blocked by
the cloud environment's network egress policy. Bull cannot pull live quotes or place
orders until these hosts are whitelisted. Add them in the session's **network egress
settings** at https://code.claude.com/docs/en/claude-code-on-the-web.

## PENDING TRADE PLAN (queued for next run when API is accessible)
- BUY NVDA 138 shares @ ~$210.33 limit | 18% trailing stop | 29% allocation
- BUY AVGO 59 shares @ ~$488 limit | 18% trailing stop | 28.8% allocation
Combined sector: 57.8% semis/tech (under 60% cap). Cash post-entry: 42.2%.

## NOTE
Paper sandbox only — separate from CJ's real Fidelity book (memory/real-portfolio-fidelity.md).
