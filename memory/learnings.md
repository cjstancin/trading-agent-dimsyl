# Learnings — Bull (paper)
# One honest, dated lesson per run. The goal is to get smarter, not to celebrate.

---

## 2026-06-19
**Network egress must be configured before the agent can trade.** This run confirmed Alpaca and Finnhub APIs are blocked (HTTP 403) by the execution environment's egress policy. A trading agent that cannot reach its broker is inert — all research is wasted if orders can never be placed. **Fix:** Add `paper-api.alpaca.markets` and `finnhub.io` to the allowed egress hosts. Without this, every run will be research-only.

**June 19 = Juneteenth — always check market holidays at run start.** Even if Alpaca were reachable, markets were closed today. Orders placed on a market holiday queue for the next open, but trailing stops set before close won't be active in after-hours. Going forward: check `https://www.nyse.com/markets/hours-calendars` or embed the US market holiday calendar so the run knows upfront whether it's a trading day.

**Holding cash while SPY rallies is the silent killer of relative performance.** The account started at $100K on June 12. No trades executed. SPY has gained ~3.8% since inception. Result: −3.8% vs benchmark with zero positions taken. The first imperative is fixing the egress issue so the planned NVDA/MSFT/QQQ entries can actually go in.

---
