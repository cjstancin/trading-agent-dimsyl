---
type: "memory"
file: "rules"
date: "2026-06-19"
profile: "AGGRESSIVE (QUALITY) PAPER — reigned in (CJ 2026-06-14)"
---

# Rules — Bull (ACTIVE PROFILE)

> These are the hard rules that override everything else, including the daily run prompt.
> Profile last set by CJ on 2026-06-14. Do not change without CJ's written approval.

## ACTIVE = AGGRESSIVE (QUALITY) PAPER — reigned in

Aggressive conviction, but **quality, liquid names** only — not churn or gambles.

### Position Sizing
- **Risk 7% of equity per trade.** `shares = (0.07 × equity) ÷ (entry − stop)`
- Cap at **30% max** per position.
- Regime overlay: NEUTRAL (VIX 16–24) → trim sizes ~25%; RISK-OFF (VIX >24) → high-conviction only.

### Portfolio Limits
- **Max 30% per position.**
- **Max sector 60%.**
- **Max 8 open positions.**
- **Keep ~10% cash buffer.** No margin.

### Stops
- **Stop on EVERY entry** (~20% trailing — wide enough to ride volatility).
- Cut any position down **~-12% from entry** unless thesis is intact AND a dated catalyst is imminent.
- Never widen a stop yourself. Propose changes in the weekly review only.

### Circuit Breakers
- **Daily-loss halt: −8% of equity** → place no new trades that day.
- **Monthly kill-switch: −25% MTD** → "STAND DOWN — no new trades" until CJ resumes.

### Universe (QUALITY ONLY)
- **Allowed:** liquid US large- & mid-cap stocks (real companies, real revenue) and liquid broad/sector ETFs (SPY/QQQ/XLK/SMH/XLC etc.).
- **EXCLUDED (hard no):**
  - Penny stocks (price < $10)
  - Leveraged / inverse ETFs (SOXL, TQQQ, 3× anything)
  - Crypto and crypto-proxy names
  - Meme / pump names
  - Illiquid / no-volume / pre-revenue lottery tickets

### Horizon
Short-to-medium swing → position hold **1 week to ~5 years**. Let winners run; concentrate in best ideas; quality over quantity.

### Keys / Secrets
- Keys from env vars only: `ALPACA_API_KEY`, `ALPACA_API_SECRET`, `ALPACA_BASE_URL`, `FINNHUB_API_KEY`, `FRED_API_KEY`, `DISCORD_WEBHOOK_URL`.
- Never print or store a secret. If one leaks, tell CJ to rotate it immediately.

### Paper-only mandate
- Endpoint: `https://paper-api.alpaca.markets` only.
- Live trading is **disabled** until CJ gives written opt-in (separate, future, documented).
- CJ's Fidelity book is real money and **entirely separate** — do not conflate.

## Change Log
- 2026-06-19 — Created this file from CLAUDE.md active profile (was missing from repo).
