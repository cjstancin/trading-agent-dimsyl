# Research Log — Bull (paper)
# Dated research notes appended each run.

---

## 2026-06-19 — Daily Run Research

### Market Regime
- **VIX: ~16.4** (closed at 16.40 on June 18, down 11% from prior day)
- Regime: **NEUTRAL** (VIX 16–24 range per strategy.md)
- VIX hit 22.22 on June 10 during tech/semi selloff, now recovered to mid-teens
- Action: trim new position sizes ~25% vs full RISK-ON aggression; be choosier on entries

### Macro / Benchmark
- S&P 500 YTD 2026: ~+10% as of early June (per Yahoo Finance / Motley Fool)
- QQQ: $729.86 on June 16 vs ATH $746.16 on June 2 (3rd week June pullback from highs)
- QQQ RSI: 73.52 (elevated — overbought signal); MACD still bullish
- SPY normalized vs Bull inception (June 12): ~+3.0% through June 19
- Bull paper (cash only, no trades): +0% → trailing SPY by −3.0%

### Market Holiday
- **June 19 (Juneteenth) = market closed.** No fills possible today.
- Next trading session: Monday June 22.

### Sector Watch: Semiconductors & AI
- Semi sector (PHLX chip index) dropped ~10% on June 5 — deepest single-day loss since March 2020
- VIX recovered strongly from June 5 selloff; semis partially rebounded by June 18
- SMH semiconductor ETF: technical "Strong Buy" per StockInvest.us; support at $621 and $581
- AI GPU demand: Nvidia Blackwell still the dominant theme; Vera Rubin (next-gen) on track H2 2026

### NVDA Research
- Last price: ~$204.65 (June 17 close per Yahoo Finance history)
- 95% analyst buy bias; consensus target ~$275 (34% upside from $205 entry)
- High analyst target: $500 (Baird, May 2026)
- Q1 FY2027 reported May 2026 — $81.6B revenue, +85% YoY; Blackwell DC revenue +17% QoQ
- Jensen Huang at GTC March 2026: expects ≥$1T cumulative revenue Blackwell + Vera Rubin by end of 2027
- Market cap ~$5T (most valuable company in world as of June 2026)
- Technical: cooling near $232 resistance; pullback to ~$205 = re-entry into uptrend
- Verdict: **MEDIUM conviction LONG**. Long-term AI infrastructure thesis; no near-term catalyst dated within a week.

### MU Research (Highest Conviction)
- Last price: ~$1,140 (up ~8.4% on June 18, new ATH per StockStory/Robinhood)
- 52-week range: $103.38 low → $1,145.87 high — up >820% in a year
- **Earnings June 24** (Q3 FY2026, period ending ~May 31)
- AI HBM memory sold out all of 2026; Micron is one of very few HBM producers
- Wall Street forecast: EPS of $20.25 (vs $1.90 last year) = ~960% YoY growth
- Revenue estimates: $33.7B–$40.9B range
- Major analyst upgrades June 18 (before Juneteenth):
  - Stifel: $1,500 (from $550)
  - Wedbush: $1,300 (from $550)
  - Deutsche Bank: $1,500 (new)
  - TD Cowen: $1,500 (new)
- Strategy triggers hit: breakout (new ATH), momentum leader (#1 semi stock), near-term dated catalyst (June 24 earnings)
- Key risk: "buy the rumor, sell the news" — expectations very high; gap-down risk post-earnings if guide disappoints
- Verdict: **HIGH conviction LONG** with pre-earnings entry. Fundamental backdrop extraordinary; risk managed by 20% trailing stop at $912.

### Rejected / Watchlist
- **QQQ**: Too elevated RSI (73.5) in NEUTRAL regime; prefer single-stock exposure over broad ETF for now. Add to watchlist for pullback to $700 area.
- **AMD**: CJ's real portfolio already ~45% AMD — aware of that concentration even though paper is independent. Prefer other names to avoid de facto AMD overcrowding from a holistic view.
- **SMH**: Would add semiconductor ETF exposure but positions MU covers the thesis more directly with higher upside.
- **INTC, MU peers**: Intel struggling on competitive positioning; Micron is the cleaner AI memory play.

### Execution Notes
- Alpaca paper API (`paper-api.alpaca.markets`) blocked by network egress policy in this run environment
- Also: ALPACA_BASE_URL env var already contains `/v2` suffix — REST calls must NOT also append `/v2/` or path becomes `/v2/v2/endpoint` (confirmed from verbose curl output)
- Both issues need to be fixed before Bull can execute autonomously

### Sources (abbreviated)
- VIX data: gurufocus.com, streetstats.finance
- S&P YTD: Yahoo Finance, Macrotrends
- NVDA: nvidianews.nvidia.com, benzinga.com, phemex.com
- MU: Motley Fool, StockStory, stocksdownunder.com, TIKR
- ETF data: altindex.com, stockinvest.us, macrotrends.net
