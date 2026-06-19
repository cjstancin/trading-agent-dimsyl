---
type: "memory"
file: "research-log"
date: "2026-06-19"
summary: "Daily research notes for Bull (paper). Dated entries, newest first."
---

# Research Log — Bull (paper)

---

## 2026-06-19 — Juneteenth (Markets Closed)

### Macro / Regime
- **VIX**: ~16.4 → **NEUTRAL** (16–24 range; just above the 16 RISK-ON threshold). Strategy calls for ~25% size trim on new entries.
- **SPY**: +10.09% YTD as of June 18; last close ~$746.74; all-time high was $759.57 on June 2, 2026.
- **QQQ**: $739.36 close June 18.
- **Fed (June 18 meeting)**: Hawkish shift under new Chair Warsh — removed rate cut from dot plot; ~half of policymakers now see a potential rate **hike** in 2026. Rates held at 3.5%–3.75%. Inflation forecasts raised; near-term growth lowered. This is a meaningful headwind for high-multiple growth names.
- **Market reaction**: Selloff June 17; recovery June 19 (Nasdaq +3%, S&P +1.9%) heading into the holiday. Markets closed Friday June 19 (Juneteenth).
- **Regime call**: **NEUTRAL**. VIX not alarming but hawkish Fed = be choosier, trim entry sizes ~25%.

### Operational Notes
- **Alpaca API**: BLOCKED — `paper-api.alpaca.markets` is not on the cloud environment's network egress allowlist. Cannot read account or positions, cannot place orders.
- **Finnhub API**: Also blocked by same egress policy.
- **Workaround**: Used WebSearch tool (web search) for all market data. Prices sourced from macrotrends, Yahoo Finance, MarketBeat, CNBC, Seeking Alpha as of June 17–18, 2026.
- **Action for CJ**: Add `paper-api.alpaca.markets`, `data.alpaca.markets`, and `finnhub.io` to the network egress allowlist in cloud execution settings.

### Key Stocks Researched

**MU (Micron Technology)** — HIGH CONVICTION → QUEUED BUY
- Last price: $1,086–$1,146 range on June 18 (midpoint ~$1,115)
- **Catalyst: Q3 FY2026 earnings June 24** — 5 trading days away
- Revenue $24B (record Q2 results); HBM demand surge + NAND shortage; crossed $1T market cap
- Wall Street hiking targets aggressively: Cantor $1,500, Daiwa $1,600, Wolfe $1,250, Morgan Stanley $1,050
- Pre-earnings momentum ("wall street supercharges AI upside targets" per Sykes June 15)
- Risk: Pre-earnings gap risk (±10–20% common); some cyclical skeptics; need stop discipline
- **Trade**: BUY limit $1,110 | stop 20% trailing (~$888) | target $1,400+ | 20% of equity | 18 shares

**INTC (Intel)** — HIGH CONVICTION → QUEUED BUY
- Last price: ~$120–130; started 2026 at $36.90; up ~250% YTD
- Catalysts: CHIPS Act grants locked in (Ohio + Arizona fabs); BofA double-upgraded to Buy June 11 (price target raised significantly); July earnings: $13.8–$14.8B revenue guidance, EPS $0.20 (above consensus)
- Foundry market share + agentic CPU positioning; AI partnerships growing
- Down −6.39% on June 16 (volatile) — potential re-entry opportunity
- Risk: Still a turnaround story (high skeptic contingent); has already run 250%, sentiment fragile
- **Trade**: BUY limit $122 | stop 20% trailing (~$97.60) | target $150–160 | 20% of equity | 163 shares

**ANET (Arista Networks)** — HIGH CONVICTION → QUEUED BUY
- Last price: $163.24 (June 15); 52-week range $85.58–$179.80
- Q1 2026 revenue +35.1% YoY to $2.71B; raised FY26 guidance to $11.5B (+27.7%)
- New 7060XE7 Series — 1.6T platforms purpose-built for AI rack-scale networking
- Analyst consensus: Strong Buy; 30 buys, 0 sells; avg PT $189.13; BofA raised to $200
- Pulled back from 52-wk high ($179.80); ~9% below ATH → good entry vs recent high
- Complements MU/INTC (networking vs memory/logic) for sector diversification
- **Trade**: BUY limit $165 | stop 20% trailing (~$132) | target $185–200 | 20% of equity | 121 shares

**NVDA (Nvidia)** — CONSIDERED, NOT QUEUED
- Price ~$211; $5.1T market cap; avg PT $275; Strong Buy consensus (38 analysts)
- Revenue +85% YoY ($81.6B Q1 FY27); margins ~70%; next earnings Aug 26
- Very strong story but CJ already owns a tiny position in Fidelity
- More differentiated paper P&L data by focusing on MU/INTC/ANET
- Will consider for position 4 once initial 3 are filled and we have capacity

**AMD** — CONSIDERED, NOT QUEUED
- Price $512 (June 17); ATH $547.26 on June 15; AI/data center story strong
- Excluded: CJ's largest real holding (70 shares, ~$36K in Fidelity). Paper account should explore different names.

**SNDK (SanDisk)** — CONSIDERED, NOT QUEUED
- Price ~$2,182; up ~4,000% since 2025 spinoff; NAND scarcity + AI storage story
- Real company with real revenue ($42B contracts), technically qualifies per universe rules
- However, at $2,182 after 4,000% run, risk/reward is uncertain and entry is extended
- 18 analysts Buy, 1 Sell; Cantor PT $2,900; but this is a momentum chase at 52-wk high
- Will revisit if it consolidates meaningfully or if a new fundamental catalyst appears

### Sector Allocation Assessment
| Sector | Names | Approx % |
|--------|-------|-----------|
| Semiconductors (memory/logic) | MU, INTC | 39.9% |
| Networking/Tech Infrastructure | ANET | 20.0% |
| Cash | — | 40.2% |
| Total IT | MU + INTC + ANET | 59.8% ✓ |

### Context: CJ's Real Portfolio
CJ's Fidelity portfolio (~$80K): AMD ~45%, MSFT ~31%, tiny NVDA, XLK, VOO, VXUS. Paper account is 99% tech to learn the AI infrastructure wave, but deliberately avoids duplicating AMD/MSFT. No AMD or MSFT in paper.
