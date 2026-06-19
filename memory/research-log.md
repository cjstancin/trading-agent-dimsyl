# Research Log — Bull (paper)
# Dated research notes. Appended each run.

---

## 2026-06-19 — Daily run

### Market regime
- **VIX: 16.41** → NEUTRAL (16–24 band). Strategy: trim new sizes ~25%, be choosier.
- VIX spike to 22.22 on June 10 (pre-Fed meeting) but has retreated. Pattern: crested 31 in late March (geopolitical), steadily declined through April–May.
- US-Iran ceasefire in place → risk-on sentiment, Nasdaq at record high.
- SPY YTD: +10.09% (through June 18). Account is flat → vs-SPY ≈ −3.5% since inception.

### Macro context
- S&P 500 closed at record 7,599.96 on May 31; all-time highs in early June.
- Major semiconductor selloff on June 5: PHLX chip index −10% (worst since March 2020). Trigger: Broadcom Q3 AI revenue guide of $16B vs $17.2B expected. Erased ~$1.3T in sector market cap.
- Semis have rebounded: Intel +11.19%, Micron +9.87% after the selloff. Market treating dip as a buying opportunity.
- Fed under new chairman: June meeting caused momentary VIX spike to 22.22. Now resolved.
- AI infrastructure spending remains robust despite one weak Broadcom guide.

### No approved-cycle signals
- Signals/approved-cycle.md: STATUS = NO ACTIVE CYCLE. Self-sourcing within strategy.md.

### Candidate 1: NVDA (NVIDIA)
- Current price: $210.33 (June 19; ATH $236.54 on May 14)
- 50-day MA: $212 (price just below); 200-day MA: $190 (bullish structure)
- Down ~11% from ATH; sitting in a weekly bull flag
- Fundamentals: Revenue $81.6B (+85% YoY), Data Center revenue $75.2B (+92% YoY)
- 62 analysts: consensus "Strong Buy," avg 12-month target $298.93
- Prediction markets: 64% odds NVDA closes ≥$216 by June end
- Setup: oversold snapback + AI momentum leader + strong fundamentals
- Qualifies: 2 triggers (oversold snapback + momentum leader). Clean quality name.

### Candidate 2: QQQ (Invesco Nasdaq 100 ETF)
- Current price: ~$744
- Performance: +11% in last 30 days (mid-April ~$637 → June ~$708 → now ~$744)
- Nasdaq 100 at record high; QQQ MAs both bullish (short-term above long-term)
- Momentum indicator briefly dipped negative on June 5 (chip selloff) — recovered
- Broad tech diversification, liquid, no single-name risk
- Qualifies: momentum leader in hot sector. Broad exposure play on AI/tech cycle.

### Candidates screened out
- Leveraged ETFs (TQQQ, SOXL): excluded per CJ's 2026-06-14 rule update (AGGRESSIVE QUALITY only)
- Broadcom (AVGO): still digesting miss; thesis temporarily broken; pass for now
- AMD: CJ owns 70 shares in real Fidelity account ($36k position); awareness context only. No paper trade needed separately.
- Marvell (MRVL): mid-cap semis, down 17% on June 5, uncertain recovery; skip

### Connectivity issue
- paper-api.alpaca.markets is NOT in the cloud egress allowlist
- All trade proposals researched and sized but could not be executed
- Account data read from last known state (June 14 dashboard snapshot)
- Action required: CJ must add Alpaca to environment egress settings
