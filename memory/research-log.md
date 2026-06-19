# Research Log — Bull (paper)
# Dated notes on market research, regime reads, thesis checks. Append each run.

---

## 2026-06-19 — Daily Run (Juneteenth, Market Closed)

### Regime
- **VIX: 16.41** — NEUTRAL (low end of 16–24 band). Per strategy.md: trim new entry sizes ~25%, be choosier.
- Narrative: VIX peaked at 31 in late March (inflation/geopolitics), retraced steadily through May. Bounced briefly to 22.22 on June 10 (profit-taking in tech ahead of Fed meeting), now back to 16.4. Market is calming down but not fully complacent.
- Inflation: May CPI 4.2% — hotter than target. Fed unlikely to cut in June. Mild headwind for growth multiples.
- Iran MOU: Peace deal in progress → oil prices easing → mild tailwind across the board.
- SpaceX IPO ($75B) completed — positive market sentiment signal.

### Macro / Market
- SPY last close (June 18): $746.74 (+0.78% on day). Near record highs.
- QQQ opened June 19 at ~$735. Tech holding up.
- Market dynamic: strong AI infrastructure spending by hyperscalers driving semis and networking. Sector dispersion wide — tech leadership, some defensives lagging.

### Holding Review (none to review — no open positions)
- N/A. Account seeded at $100K, no trades executed to date due to Alpaca API network restriction.

### Stock Research

**NVDA ($210.33, range $206.50–$211.39)**
- Volume: 241.27M vs 161.7M avg → significant breakout volume
- Thesis: Dominant AI training GPU supplier; hyperscalers (MSFT, META, AMZN, GOOGL) continue massive Blackwell/Hopper capex. No fundamental damage. Price near highs on high volume = breakout + momentum leader.
- Signals triggered: Breakout (multi-week high) + Momentum leader (strongest AI name) = 2/5 entry criteria ✅
- Concerns: Premium valuation (P/E 31.34), some competition from AVGO custom ASICs, but thesis intact.
- Decision: **ENTER** — highest conviction idea this cycle.

**AVGO ($483.47, RSI 75.32)**
- JPMorgan raised PT to $580 from $500, maintained Buy.
- Up ~82% in 12 months (vs NVDA +55%).
- Custom AI ASIC wins (Meta, Google) providing diversification away from NVDA dependency for hyperscalers.
- BUT: RSI 75 = overbought. Trading above upper Bollinger Band. "Late-stage breakout zone" per analyst commentary.
- Decision: **SKIP** — too overbought for clean entry. Add to watchlist for pullback to ~$440–$450 or if RSI cools to 60.

**AMD ($547, ATH Jun 15)**
- Strong momentum, all-time high June 15.
- AI GPU and CPU secular demand narrative intact.
- CJ's real Fidelity account: 70 shares AMD (~$38K, ~45% of real portfolio). Aware of this.
- Decision: **SKIP** — not because of a bad thesis, but because CJ is already heavily concentrated in AMD in real money. No need to double the paper account on top.

**MSFT ($390–$396, opened $395.79)**
- Consolidating near multi-week highs.
- AI Copilot monetization ongoing. Azure AI revenue accelerating.
- Safer, quality name. Lower beta than NVDA.
- Signals: Momentum leader (cloud/AI) — 1/5 entry criteria. Quality name with solid catalyst backdrop.
- Decision: **ENTER** — solid quality add to balance NVDA's higher volatility.

**QQQ (~$735)**
- Tech broad exposure ETF. Good for catching the general AI/tech rally without single-stock risk.
- Acts as a diversifier given NVDA and MSFT are both in the portfolio.
- Decision: **ENTER** — 22% position to provide broad exposure and reduce idiosyncratic risk.

**INTC ($210 range)**
- Noted +6.5% single-day move on analyst upgrades and AI demand.
- But Intel is structurally recovering — it's a turnaround story, not a pure AI momentum play.
- Decision: **SKIP** — prefer NVDA as the AI semi leader. INTC's thesis is less clean.

### Opportunities Monitored but Not Actionable
- ANET, LITE, COHR, HPE: AI data center networking. Strong institutional momentum. Research further next cycle.
- ARM: AI chip design IP. Strong momentum in 2026. Worth deeper research for next approved-cycle.

### What I Couldn't Do This Run
- Alpaca API blocked by network egress (HTTP 403). Cannot read live equity/positions or place orders.
- Finnhub API also blocked (HTTP 403). No live quotes from Finnhub.
- June 19 = Juneteenth (NYSE closed). No orders would fill today regardless.
- **Action needed:** Add `paper-api.alpaca.markets` and `finnhub.io` to network egress allowlist.

---
